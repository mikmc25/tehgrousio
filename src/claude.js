/**
 * DNS-resilient fetch wrapper to avoid ENOTFOUND errors from undici/Node.js DNS caching.
 */
import { lookup } from 'node:dns/promises';
import http from 'http';
import https from 'https';
import fetch from 'node-fetch';

async function fetchWithSafeDNS(url, options = {}) {
    const { hostname } = new URL(url);
    const { address } = await lookup(hostname);
    const agent = url.startsWith('https')
        ? new https.Agent({ lookup: (_, __, cb) => cb(null, address, 4) })
        : new http.Agent({ lookup: (_, __, cb) => cb(null, address, 4) });
    return fetch(url, { ...options, agent });
}

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDebridServices } from './src/debrids.js';
import { RealDebrid } from './src/realdebrid.js';
import { DebridLink } from './src/debridlink.js';
import { Premiumize } from './src/premiumize.js';
import { TorBox } from './src/torbox.js';
import { isVideo, base64Encode, base64Decode, extractInfoHash, detectVideoFeatures, parseQuality, parseSize } from './src/util.js';
import { ERROR, STREAM_SOURCES } from './src/const.js';
import { checkRDCache } from './src/rdhelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ID type detection helper
function getIdType(id) {
    if (id.startsWith('tt')) return 'imdb';
    if (/^\d+$/.test(id)) return 'tmdb';
    return null;
}

// Function to get appropriate quality symbol based on quality value
function getQualitySymbol(quality) {
    // Convert quality to lowercase for case-insensitive matching
    const qualityStr = String(quality).toLowerCase();
    
    // Return symbol based on quality
    if (qualityStr.includes('2160') || qualityStr.includes('4k') || qualityStr.includes('uhd')) {
        return '🗣💨'; // 4K/UHD content
    } else if (qualityStr.includes('1080')) {
        return '🙊'; // Full HD
    } else if (qualityStr.includes('720')) {
        return '🙉'; // HD
    } else if (qualityStr.includes('480')) {
        return '🤬'; // SD
    } else if (qualityStr.includes('cam') || qualityStr.includes('hdts')) {
        return '📹'; // CAM/TS quality
    } else {
        return '🙈'; // Default/unknown quality
    }
}

function sortStreams(streams) {
    return streams.sort((a, b) => {
        // Parse quality and size from stream names
        const qualityA = parseQuality(a.name);
        const qualityB = parseQuality(b.name);
        const sizeA = parseSize(a.name);
        const sizeB = parseSize(b.name);

        // Group by quality first
        if (qualityA !== qualityB) {
            return qualityB - qualityA; // Higher quality first
        }

        // If same quality, prefer reasonable file sizes
        // For each quality level, define ideal size ranges (in MB)
        const idealSizeRanges = {
            2160: { min: 10000, max: 80000 },   // 10GB - 80GB for 4K
            1080: { min: 2000, max: 16000 },    // 2GB - 16GB for 1080p
            720: { min: 1000, max: 8000 },      // 1GB - 8GB for 720p
            480: { min: 500, max: 4000 }        // 500MB - 4GB for 480p
        };

        const idealRange = idealSizeRanges[qualityA] || { min: 0, max: Infinity };

        // Calculate how far each size is from the ideal range
        const getIdealScore = (size, range) => {
            if (size >= range.min && size <= range.max) return 0;
            if (size < range.min) return range.min - size;
            return size - range.max;
        };

        const scoreA = getIdealScore(sizeA, idealRange);
        const scoreB = getIdealScore(sizeB, idealRange);

        // Sort by how close they are to ideal range
        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }

        // If everything else is equal, prefer larger size
        return sizeB - sizeA;
    });
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.options('*', cors());

// Configuration page endpoint
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Root manifest endpoint
app.get('/manifest.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const manifest = {
        id: 'org.magnetio.hy',
        version: '2.0.0',
        name: '🅷 🅈 🅸👁',
        description: 'Stream movies and series via Debrid services - Configuration Required',
        resources: [],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'tmdb'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: true,
            configurationURL: `${baseUrl}/configure`
        }
    };
    res.json(manifest);
});

// Configured manifest endpoint
app.get('/:apiKeys/manifest.json', (req, res) => {
    const { apiKeys } = req.params;
    const debridServices = getDebridServices(apiKeys);
    
    // Check if we have valid API keys
    if (!debridServices.length) {
        return res.json({
            id: 'org.magnetio.hy',
            version: '2.0.0',
            name: '🅷 🅈 🅸👁 - ❌ No Services',
            description: 'No valid debrid services configured. Please check your API keys and try again.',
            resources: [],
            types: ['movie', 'series'],
            idPrefixes: ['tt', 'tmdb'],
            catalogs: [],
            behaviorHints: {
                configurable: true,
                configurationRequired: true,
                configurationURL: `${req.protocol}://${req.get('host')}/configure`
            }
        });
    }

    // Return full manifest with streaming capabilities
    const manifest = {
        id: 'org.magnetio.hy',
        version: '2.0.0',
        name: '🅷 🅈 🅸👁',
        description: 'Stream movies and series via Debrid services',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'tmdb'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            adult: true
        }
    };
    res.json(manifest);
});
async function getStreams(type, id, season = null, episode = null) {
    try {
        console.log('\n🔄 Fetching streams from APIs');
        
        let query;
        const idType = getIdType(id);
        if (!idType) {
            console.error('Invalid ID format:', id);
            return [];
        }

        if (type === 'series') {
            if (!season || !episode) throw new Error('Season and episode required for series');
            query = `${id}:${season}:${episode}`;
        } else {
            query = id;
        }

        // Fetch from all APIs concurrently
        const fetchPromises = Object.values(STREAM_SOURCES).map(async (source) => {
            try {
                const apiUrl = `${source.url}/api/search?type=${type}&query=${encodeURIComponent(query)}`;
                console.log(`Fetching from ${source.name}:`, apiUrl);
                
                const response = await fetch(apiUrl, { 
                    timeout: 10000,  // 10 second timeout
                    headers: { 'User-Agent': 'Stremio-Magnetio-Addon/1.0' }
                });
                
                if (!response.ok) {
                    console.error(`API response not ok from ${source.name}:`, response.status);
                    return [];
                }
                
                const data = await response.json();
                if (!data?.results?.length) {
                    console.log(`No results found from ${source.name}`);
                    return [];
                }

                console.log(`Found ${data.results.length} results from ${source.name}`);
                
                // Add source information to each result
                return data.results.map(result => ({
                    ...result,
                    source: source.name
                }));
            } catch (error) {
                console.error(`Error fetching from ${source.name}:`, error);
                return [];
            }
        });

        // Wait for all APIs to respond
        const allResults = await Promise.all(fetchPromises);
        
        // Combine and filter results
        const seenMagnets = new Set();
        const combinedResults = allResults
            .flat()
            .reduce((unique, stream) => {
                try {
                    if (!stream?.magnetLink) return unique;

                    // Extract hash from magnet link for storage
                    const hash = stream.magnetLink.match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase();
                    if (!hash || seenMagnets.has(hash)) return unique;

                    // **RESTORED SERIES FILTERING LOGIC**
                    if (type === 'series') {
                        const filename = stream.filename || stream.title || '';
                        const seasonNum = parseInt(season);
                        const episodeNum = parseInt(episode);
                        
                        // Check if this stream matches the specific season and episode
                        const seasonEpisodePattern = new RegExp(`s0*${seasonNum}e0*${episodeNum}\\b`, 'i');
                        const seasonXEpisodePattern = new RegExp(`${seasonNum}x0*${episodeNum}\\b`, 'i');
                        
                        // Also check for season pack patterns that contain the specific episode
                        const seasonPackPattern = new RegExp(`s0*${seasonNum}\\b(?!e\\d)`, 'i'); // Season pack (S01 but not S01E02)
                        const completeSeasonPattern = new RegExp(`season\\s*0*${seasonNum}\\b`, 'i');
                        
                        const hasSpecificEpisode = seasonEpisodePattern.test(filename) || seasonXEpisodePattern.test(filename);
                        const isSeasonPack = seasonPackPattern.test(filename) || completeSeasonPattern.test(filename);
                        
                        // Only include if it's the specific episode OR a season pack containing that episode
                        if (!hasSpecificEpisode && !isSeasonPack) {
                            console.log(`Filtering out series stream: ${filename} (doesn't match S${season}E${episode})`);
                            return unique;
                        }
                        
                        // For season packs, verify they actually contain the episode range
                        if (isSeasonPack && !hasSpecificEpisode) {
                            // Check if it's a partial season that doesn't include our episode
                            const episodeRangeMatch = filename.match(/e(\d+)-e(\d+)/i);
                            if (episodeRangeMatch) {
                                const startEp = parseInt(episodeRangeMatch[1]);
                                const endEp = parseInt(episodeRangeMatch[2]);
                                if (episodeNum < startEp || episodeNum > endEp) {
                                    console.log(`Filtering out partial season pack: ${filename} (episode ${episodeNum} not in range ${startEp}-${endEp})`);
                                    return unique;
                                }
                            }
                        }
                        
                        console.log(`Including series stream: ${filename} for S${season}E${episode}`);
                    }

                    seenMagnets.add(hash);

                    // Better quality parsing
                    const quality = stream.quality || 
                                  stream.title?.match(/\d{3,4}p|4k|uhd|HDTS|CAM/i)?.[0] || '';
                    
                    // Better size parsing 
                    const size = stream.size || 
                               stream.title?.match(/\d+(\.\d+)?\s*(GB|MB)/i)?.[0] || '';

                    const filename = stream.filename || stream.title?.split('\n')[0]?.trim() || 'Unknown';
                    
                    // Store the original magnet link
                    unique.push({
                        hash,
                        magnetLink: stream.magnetLink,
                        filename,
                        websiteTitle: stream.title || filename,
                        quality,
                        size,
                        source: stream.source || 'Unknown'
                    });

                    return unique;
                } catch (error) {
                    console.error('Error processing stream:', error);
                    return unique;
                }
            }, []);

        console.log(`Found ${combinedResults.length} unique streams from all sources`);
        return combinedResults;
    } catch (error) {
        console.error('❌ Error fetching streams:', error);
        return [];
    }
}

async function checkCacheStatuses(service, streams) {
    if (!streams?.length) return {};

    try {
        const validStreams = streams.filter(stream => stream && stream.hash);
        if (!validStreams.length) return {};

        const hashes = validStreams.map(stream => stream.hash.toLowerCase());
        const results = await service.checkCacheStatuses(hashes);

        const cacheMap = {};
        validStreams.forEach(stream => {
            if (!stream || !stream.hash) return;

            const hash = stream.hash.toLowerCase();
            const result = results[hash];

            if (!result) return;

            let quality = stream.quality || '';
            if (!quality) {
                const qualityMatch = stream.filename?.match(/\d{3,4}p|4k|uhd|HDTS|CAM/i);
                if (qualityMatch) quality = qualityMatch[0];
            }

            let size = stream.size || '';
            if (!size) {
                const sizeMatch = stream.filename?.match(/\d+(\.\d+)?\s*(GB|MB)/i);
                if (sizeMatch) size = sizeMatch[0];
            }

            cacheMap[hash] = {
                ...result,
                hash,
                magnetLink: stream.magnetLink,
                filename: stream.filename || 'Unknown',
                websiteTitle: stream.websiteTitle || stream.filename || 'Unknown',
                quality,
                size,
                source: stream.source || 'Unknown',
                cached: result.cached !== false
            };
        });

        return cacheMap;
    } catch (error) {
        console.error('Cache check error:', error);
        return {};
    }
}
app.get('/:apiKeys/stream/:type/:id.json', async (req, res) => {
    const { apiKeys, type, id } = req.params;
    
    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            console.log('❌ No debrid services configured');
            return res.json({ 
                streams: [{
                    name: "❌ No Debrid Services",
                    title: "No valid debrid services are configured.\nPlease check your API keys in the addon configuration.",
                    url: "#"
                }]
            });
        }

        let tmdbId = id;
        let season = null;
        let episode = null;

        // Handle series ID format
        if (type === 'series') {
            [tmdbId, season, episode] = id.split(':');
        }

        const idType = getIdType(tmdbId);
        if (!idType) {
            console.error('Invalid ID format:', tmdbId);
            return res.json({ streams: [] });
        }

        console.log(`Processing ${idType.toUpperCase()} ID: ${tmdbId}`);

        // Fetch streams directly from APIs
        const newStreams = await getStreams(type, tmdbId, season, episode);
        
        if (!newStreams.length) {
            console.log('No streams found from torrent sources');
            return res.json({ 
                streams: [{
                    name: "🔍 No Torrents Found",
                    title: "No torrents found for this content.\nTry searching for alternative titles or check back later.",
                    url: "#"
                }]
            });
        }
        
        console.log(`Found ${newStreams.length} streams from sources`);
        
        // Create a map to track which streams have been processed
        const allProcessedStreams = [];
        let hasWorkingService = false;

        for (const service of debridServices) {
            const serviceName = service.constructor?.name || 'UnknownDebrid';
            console.log(`\n🔍 Checking cache status with ${serviceName}`);

            let cacheMap = {};

            try {
                if (serviceName === 'RealDebrid' || service.serviceName === 'RealDebrid') {
                    cacheMap = await checkRDCache(service, newStreams);
                } else if (typeof service.checkCacheStatuses === 'function') {
                    cacheMap = await checkCacheStatuses(service, newStreams);
                } else {
                    console.warn(`⚠️ ${serviceName} does not support checkCacheStatuses`);
                    continue;
                }

                hasWorkingService = true;
                const cachedCount = Object.values(cacheMap).filter(r => r.cached).length;
                console.log(`${serviceName} found ${Object.keys(cacheMap).length} torrents, ${cachedCount} are cached out of ${newStreams.length}`);

                // Add all cached streams from this service to our list
                for (const stream of Object.values(cacheMap)) {
                    if (stream && stream.hash && stream.cached) {
                        allProcessedStreams.push({
                            stream,
                            service: serviceName,
                            hash: stream.hash.toLowerCase()
                        });
                    }
                }
            } catch (err) {
                console.error(`❌ Error checking cache for ${serviceName}:`, err.message);
            }
        }

        // Check if we have any working services
        if (!hasWorkingService) {
            console.log('❌ No debrid services are working');
            return res.json({ 
                streams: [{
                    name: "⚠️ Service Unavailable",
                    title: "All debrid services are currently unavailable.\nPlease check your API keys and try again later.",
                    url: "#"
                }]
            });
        }
        
        console.log(`Processing ${allProcessedStreams.length} cached streams from all services`);
        
        // If no cached streams found, return appropriate message
        if (!allProcessedStreams.length) {
            console.log('❌ No cached streams found');
            return res.json({ 
                streams: [{
                    name: "💾 No Cached Content",
                    title: "No cached torrents found for this content.\nContent needs to be cached by your debrid service first.",
                    url: "#"
                }]
            });
        }
        
        // Format all streams for Stremio
        const formattedStreams = [];
        
        allProcessedStreams.forEach(({ stream, service, hash }) => {
            try {
                // Ensure required fields exist
                if (!stream) {
                    console.log(`Stream ${hash} is undefined!`);
                    return;
                }
                
                if (!stream.magnetLink) {
                    console.log(`Stream ${hash} has no magnetLink!`);
                    // Reconstruct magnet link if needed
                    if (hash) {
                        stream.magnetLink = `magnet:?xt=urn:btih:${hash}`;
                        console.log(`Created magnetLink from hash: ${stream.magnetLink}`);
                    } else {
                        return; // Skip if we can't create a magnet link
                    }
                }
                
                // Ensure filename exists
                if (!stream.filename) {
                    stream.filename = stream.websiteTitle || hash || "Unknown";
                    console.log(`Using fallback filename: ${stream.filename}`);
                }
                
                // Get video features
                const features = detectVideoFeatures(stream.filename);
                const featureStr = features.length ? features.join(' | ') : '';
                
                // Format quality display
                const qualityDisplay = stream.quality ? stream.quality.toUpperCase() : '';
                
                // Get quality symbol based on the quality
                const qualitySymbol = getQualitySymbol(qualityDisplay || stream.filename);
                
                // Format debrid service name for display
                const debridService = service || 'Unknown';
                
                // Format the stream name INCLUDING the debrid service
                const streamName = [
                    qualitySymbol,  // Dynamic quality symbol
                    qualityDisplay, 
                    stream.size,
                    debridService,  // Added debrid service back to stream name
                    '𝐇𝐘-𝐈☘️̤̮'
                ].filter(Boolean).join(' | ');
                
                // Create a more detailed title with source and features
                const streamTitle = [
                    stream.filename,
                    [
                        `🦉 ${stream.source}`,
                        featureStr
                    ].filter(Boolean).join(' | ')
                ].filter(Boolean).join('\n');
                
                formattedStreams.push({
                    name: streamName,
                    title: streamTitle,
                    url: `${req.protocol}://${req.get('host')}/${apiKeys}/${base64Encode(stream.magnetLink)}`,
                    service: service
                });
                
            } catch (error) {
                console.error(`Error formatting stream ${hash}:`, error);
            }
        });
        
        // Sort streams by quality and ideal size
        const sortedStreams = sortStreams(formattedStreams);
        
        console.log(`\n✅ Sending ${sortedStreams.length} streams`);
        res.json({ streams: sortedStreams });
        
    } catch (error) {
        console.error('❌ Error in stream endpoint:', error.message);
        res.status(500).json({ 
            streams: [{
                name: "💥 Server Error",
                title: "An unexpected error occurred while processing your request.\nPlease try again later.",
                url: "#"
            }],
            error: 'Internal server error',
            details: error.message 
        });
    }
});

app.get('/:apiKeys/:magnetLink', async (req, res) => {
    const { apiKeys, magnetLink } = req.params;

    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            return res.status(404).json({ 
                error: 'No debrid services configured',
                message: 'Please configure your debrid service API keys'
            });
        }

        console.log('\n🧲 Processing magnet request');
        const decodedMagnet = base64Decode(magnetLink);
        const hash = extractInfoHash(decodedMagnet)?.toLowerCase();

        if (!hash) {
            return res.status(400).json({ 
                error: 'Invalid magnet link',
                message: 'Could not extract hash from magnet link'
            });
        }

        // Optional: detect media type from referer
        const mediaInfo = (() => {
            try {
                const urlParts = req.get('referer')?.split('/') || [];
                const streamIndex = urlParts.findIndex(part => part === 'stream');

                if (streamIndex !== -1 && urlParts[streamIndex + 1] === 'series') {
                    const seriesId = urlParts[streamIndex + 2];
                    const [, season, episode] = seriesId.split(':');
                    return {
                        type: 'series',
                        season: parseInt(season),
                        episode: parseInt(episode)
                    };
                }

                return { type: 'movie' };
            } catch (err) {
                console.warn('Could not extract media info from referer');
                return { type: 'movie' };
            }
        })();

        let hasWorkingService = false;
        const serviceErrors = [];

        for (const service of debridServices) {
            try {
                const serviceName = service.constructor.name;
                console.log(`Trying service: ${serviceName}`);
                hasWorkingService = true;

                if (service instanceof RealDebrid) {
                    // ✅ Check cache status first
                    const availability = await service.checkInstantAvailability([hash]);
                    if (!availability[hash]?.cached) {
                        console.log(`❌ ${serviceName}: Torrent is not cached, skipping`);
                        serviceErrors.push(`${serviceName}: Not cached`);
                        continue;
                    }

                    // ✅ Get stream only if cached
                    const result = await service.getCachedUrl(decodedMagnet);
                    if (typeof result === 'string' && result.startsWith('http')) {
                        console.log(`✅ ${serviceName} success - redirecting to stream`);
                        return res.redirect(result);
                    } else {
                        console.log(`❌ ${serviceName} failed - no cached URL returned`);
                        serviceErrors.push(`${serviceName}: Failed to get stream URL`);
                        continue;
                    }
                } else {
                    // Handle other services normally
                    const streamUrl = await service.getStreamUrl(decodedMagnet);
                    console.log(`✅ ${serviceName} success - redirecting to stream`);
                    return res.redirect(streamUrl);
                }

            } catch (error) {
                if (error.message === ERROR.NOT_PREMIUM) {
                    console.log(`⚠️ Skipping non-premium service`);
                    serviceErrors.push(`${service.constructor.name}: Not premium`);
                    continue;
                }
                console.error(`${service.constructor.name} failed:`, error.message);
                serviceErrors.push(`${service.constructor.name}: ${error.message}`);
            }
        }

        // Better error messages based on what went wrong
        if (!hasWorkingService) {
            return res.status(503).json({ 
                error: 'No debrid services available',
                message: 'All configured debrid services are currently unavailable',
                details: serviceErrors
            });
        } else {
            return res.status(404).json({ 
                error: 'Stream not available',
                message: 'No cached stream available from any debrid service',
                details: serviceErrors
            });
        }

    } catch (error) {
        console.error('❌ Error processing magnet:', error.message);
        res.status(500).json({ 
            error: 'Server error',
            message: 'An unexpected error occurred while processing the magnet link',
            details: error.message 
        });
    }
});

const port = process.env.PORT || 9516;
app.listen(port, () => console.log(`\n🚀 Addon running at http://localhost:${port}`));