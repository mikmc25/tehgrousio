import { fetchFromModules } from './src/fetchFromModules.js';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import AsyncLock from 'async-lock';
import { getDebridServices, DebridLink, Premiumize, TorBox } from './src/debrids.js';
import { RealDebrid } from './src/realdebrid.js';
import { checkRDCache } from './src/rdhelper.js';
import { isVideo, base64Encode, base64Decode, extractInfoHash, detectVideoFeatures, parseQuality, parseSize } from './src/util.js';
import { ERROR, STREAM_SOURCES } from './src/const.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const lock = new AsyncLock();

// In-memory storage to replace MongoDB
const inMemoryDB = {
  content: new Map(),
  
  async findOne(query) {
    const contentKey = this.generateKey(query);
    return this.content.get(contentKey) || null;
  },
  
  async find(query, projection) {
    const results = [];
    for (const [key, content] of this.content.entries()) {
      if (query['streams.hash'] && query['streams.hash'].$in) {
        const matchingStreams = content.streams.filter(stream => 
          query['streams.hash'].$in.includes(stream.hash.toLowerCase())
        );
        
        if (matchingStreams.length > 0) {
          results.push(content);
        }
      }
    }
    return results;
  },
  
  generateKey(query) {
    let key = `${query.type}-${query.tmdbId}`;
    if (query.type === 'series' && query.season && query.episode) {
      key += `-${query.season}-${query.episode}`;
    }
    return key;
  },
  
  async save(contentData) {
    const contentKey = this.generateKey(contentData);
    this.content.set(contentKey, {...contentData});
    return contentData;
  }
};

// Function to get quality symbol based on quality string
function getQualitySymbol(qualityStr) {
    if (!qualityStr) return '🤬';
    
    const qualityLower = qualityStr.toLowerCase();
    
    if (qualityLower.includes('4k') || qualityLower.includes('2160p') || qualityLower.includes('uhd')) {
        return '🗣💨';
    } else if (qualityLower.includes('1080p') || qualityLower.includes('fhd')) {
        return '🙉';
    } else if (qualityLower.includes('720p') || qualityLower.includes('hd')) {
        return '🙈';
    } else if (qualityLower.includes('480p') || qualityLower.includes('sd')) {
        return '🙊';
    } else if (qualityLower.includes('cam') || qualityLower.includes('ts') || qualityLower.includes('hdts')) {
        return '📹';
    } else {
        return '🤬';
    }
}

// Helper function to create stream entries with proper service preference
function createStreamEntry(stream, service, req) {
    let serviceName = 'Unknown';
    if (service === 'debridlink') serviceName = 'DebridLink';
    if (service === 'premiumize') serviceName = 'Premiumize';
    if (service === 'torbox') serviceName = 'TorBox';
    if (service === 'realdebrid') serviceName = 'RealDebrid';
    
    const qualityDisplay = stream.quality ? stream.quality.toUpperCase() : '';
    const qualitySymbol = getQualitySymbol(qualityDisplay || stream.filename);
    const features = detectVideoFeatures(stream.filename);
    const featureStr = features.length ? ` | ${features.join(' | ')}` : '';
    
    const streamName = [
        qualitySymbol,
        qualityDisplay, 
        stream.size,
        `≈🄷🅈🴽‽‾☠️`
    ].filter(Boolean).join(' | ');
    
    const streamTitle = [
        stream.filename,
        [
            `🤖 ${stream.source}`,
            featureStr
        ].filter(Boolean).join(' | ')
    ].filter(Boolean).join('\n');
    
    const hash = stream.hash.toLowerCase();
    const magnetLink = `magnet:?xt=urn:btih:${hash}&service=${service}`;
    
    return {
        name: streamName,
        title: streamTitle,
        url: `${req.protocol}://${req.get('host')}/${req.params.apiKeys}/${base64Encode(magnetLink)}`,
        service: service,
        quality: parseQuality(stream.filename || ''),
        size: parseSize(stream.filename || '')
    };
}

// Function to group and sort streams
function groupAndSortStreams(streams) {
    return streams.sort((a, b) => {
        const qualityA = a.quality || parseQuality(a.name);
        const qualityB = b.quality || parseQuality(b.name);
        const sizeA = a.size || parseSize(a.name);
        const sizeB = b.size || parseSize(b.name);

        if (qualityA !== qualityB) {
            return qualityB - qualityA;
        }

        const idealSizeRanges = {
            2160: { min: 10000, max: 80000 },
            1080: { min: 2000, max: 16000 },
            720: { min: 1000, max: 8000 },
            480: { min: 500, max: 4000 }
        };

        const idealRange = idealSizeRanges[qualityA] || { min: 0, max: Infinity };

        const getIdealScore = (size, range) => {
            if (size >= range.min && size <= range.max) return 0;
            if (size < range.min) return range.min - size;
            return size - range.max;
        };

        const scoreA = getIdealScore(sizeA, idealRange);
        const scoreB = getIdealScore(sizeB, idealRange);

        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }

        return sizeB - sizeA;
    });
}

// Function to standardize ID format
function standardizeId(id) {
    if (id.startsWith('tmdb-')) {
        return id.replace('tmdb-', 'tmdb:');
    }
    return id;
}

// ID type detection helper
function getIdType(id) {
    if (id.startsWith('tt')) return 'imdb';
    if (id.startsWith('tmdb:')) return 'tmdb';
    if (id.startsWith('tmdb-')) return 'tmdb';
    if (/^\d+$/.test(id)) return 'tmdb';
    return null;
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
        version: '1.0.0',
        name: '🅷 🅈 🅸💃‍♀️',
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
    
    if (!debridServices.length) {
        return res.json({
            id: 'org.magnetio.hy',
            version: '1.0.0',
            name: '🅷 🅈 🅸💃‍♀️',
            description: 'Invalid API keys provided - Please check your configuration',
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

    const manifest = {
        id: 'org.magnetio.hy',
        version: '1.0.0',
        name: '🅷 🅈 🅸💃‍♀️',
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

// Function to check database cache status
async function checkDatabaseCacheStatus(hashes, serviceNames) {
    if (!hashes?.length || !serviceNames?.length) return { results: {}, hashesToCheck: hashes };

    try {
        console.log(`\n🗂 Checking database cache for ${hashes.length} hashes`);
        console.log(`Available services: ${serviceNames.join(', ')}`);

        const query = {
            'streams.hash': { $in: hashes }
        };

        const contents = await inMemoryDB.find(query);
        console.log(`Found ${contents.length} content entries with matching hashes`);

        const results = {};
        let cachedCount = 0;

        hashes.forEach(hash => {
            results[hash] = {
                cached: false,
                fromDatabase: true,
                services: [],
                lastChecked: null
            };
        });

        contents.forEach(content => {
            content.streams.forEach(stream => {
                const hash = stream.hash.toLowerCase();
                if (hashes.includes(hash)) {
                    const cachedServices = [];
                    
                    serviceNames.forEach(service => {
                        if (stream.cachedOn && stream.cachedOn[service]) {
                            cachedServices.push(service);
                        }
                    });
                    
                    if (cachedServices.length > 0) {
                        results[hash].cached = true;
                        results[hash].services = cachedServices;
                        cachedCount++;
                    }
                    
                    results[hash].lastChecked = stream.lastChecked;
                }
            });
        });

        console.log(`Found ${cachedCount} cached hashes in database`);
        
        const CACHE_VALID_HOURS = 12;
        const now = new Date();
        
        const hashesToCheck = hashes.filter(hash => {
            const result = results[hash];
            
            if (!result.cached) return true;
            if (!result.lastChecked) return true;
            
            const hoursSinceLastCheck = (now - new Date(result.lastChecked)) / (1000 * 60 * 60);
            return hoursSinceLastCheck > CACHE_VALID_HOURS;
        });
        
        console.log(`Need to check ${hashesToCheck.length} hashes with API`);
        
        return {
            results,
            hashesToCheck
        };
    } catch (error) {
        console.error('Error checking database cache:', error);
        return {
            results: {},
            hashesToCheck: hashes
        };
    }
}

async function readContentData(type, tmdbId, season = null, episode = null) {
    try {
        console.log(`\n🗂 Reading ${type} data for ID ${tmdbId}`);
        
        let dbId = tmdbId;
        if (dbId.startsWith('tmdb:')) {
            dbId = dbId.replace('tmdb:', '');
        } else if (dbId.startsWith('tmdb-')) {
            dbId = dbId.replace('tmdb-', '');
        }
        
        const query = {
            tmdbId: dbId,
            type
        };

        if (type === 'series') {
            query.season = season;
            query.episode = episode;
        }

        const content = await inMemoryDB.findOne(query);
        
        if (content) {
            console.log(`✅ Found ${type}: ${content.title}`);
            console.log(`Found ${content.streams.length} streams`);
        }
        
        return content;
    } catch (error) {
        console.error(`❌ Error reading ${type} data:`, error);
        return null;
    }
}

// Your original working getStreams function
async function getStreams(type, id, season = null, episode = null) {
    try {
        console.log('\n📄 Fetching streams from APIs');
        
        const standardId = standardizeId(id);
        
        let query;
        const idType = getIdType(standardId);
        if (!idType) {
            console.error('Invalid ID format:', id);
            return [];
        }

        if (type === 'series') {
            if (!season || !episode) throw new Error('Season and episode required for series');
            query = `${standardId}:${season}:${episode}`;
        } else {
            query = standardId;
        }

        const results = await fetchFromModules({ query, type });
        
        if (!results || !results.length) {
            console.log('No streams found from fetchFromModules');
            return [];
        }

        console.log(`Found ${results.length} unique streams from all sources`);

        const processedResults = results.map(result => {
            try {
                const hash = result.magnetLink?.match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase();
                if (!hash) return null;

                const quality = result.quality || 
                              result.title?.match(/\d{3,4}p|4k|uhd|HDTS|CAM/i)?.[0] || '';
                
                const size = result.size || 
                           result.title?.match(/\d+(\.\d+)?\s*(GB|MB)/i)?.[0] || '';

                const filename = result.filename || result.title?.split('\n')[0].trim() || 'Unknown';
                
                return {
                    hash,
                    magnetLink: result.magnetLink,
                    filename,
                    websiteTitle: result.title || filename,
                    quality,
                    size,
                    source: result.source
                };
            } catch (error) {
                console.error('Error processing stream:', error);
                return null;
            }
        }).filter(Boolean);

        console.log(`Processed ${processedResults.length} valid streams`);
        return processedResults;
    } catch (error) {
        console.error('❌ Error fetching streams:', error);
        return [];
    }
}

async function mergeAndSaveStreams(type, tmdbId, newStreams = [], title, season = null, episode = null) {
    let dbId = tmdbId;
    if (dbId.startsWith('tmdb:')) {
        dbId = dbId.replace('tmdb:', '');
    } else if (dbId.startsWith('tmdb-')) {
        dbId = dbId.replace('tmdb-', '');
    }
    
    const lockKey = `${type}-${dbId}-${season}-${episode}`;
    
    try {
        return await lock.acquire(lockKey, async () => {
            if (!newStreams.length) return [];

            const query = { tmdbId: dbId, type };
            if (type === 'series') {
                query.season = season;
                query.episode = episode;
            }

            let content = await inMemoryDB.findOne(query);
            const now = new Date();

            if (!content) {
                content = {
                    tmdbId: dbId,
                    type,
                    title,
                    season,
                    episode,
                    streams: [],
                    lastUpdated: now
                };
            }

            const existingStreamsByHash = {};
            content.streams.forEach(stream => {
                existingStreamsByHash[stream.hash.toLowerCase()] = stream;
            });

            const streamsToAdd = [];
            const streamsToUpdate = [];

            newStreams.forEach(newStream => {
                const hash = newStream.hash.toLowerCase();
                const existingStream = existingStreamsByHash[hash];

                if (existingStream) {
                    let updated = false;
                    
                    if (newStream.cachedOn) {
                        if (!existingStream.cachedOn) {
                            existingStream.cachedOn = {};
                        }
                        
                        ['debridlink', 'premiumize', 'torbox', 'realdebrid'].forEach(service => {
                            if (newStream.cachedOn[service] !== undefined && 
                                existingStream.cachedOn[service] !== newStream.cachedOn[service]) {
                                existingStream.cachedOn[service] = newStream.cachedOn[service];
                                updated = true;
                            }
                        });
                    }
                    
                    existingStream.lastChecked = now;
                    
                    if (updated) {
                        streamsToUpdate.push(existingStream);
                    }
                } else {
                    streamsToAdd.push({
                        hash: hash,
                        filename: newStream.filename,
                        websiteTitle: newStream.websiteTitle,
                        quality: newStream.quality,
                        size: newStream.size,
                        source: newStream.source,
                        cachedOn: newStream.cachedOn || {
                            debridlink: false,
                            premiumize: false,
                            torbox: false,
                            realdebrid: false
                        },
                        lastChecked: now,
                        addedAt: now
                    });
                }
            });

            if (streamsToAdd.length === 0 && streamsToUpdate.length === 0) {
                await inMemoryDB.save(content);
                return content.streams;
            }

            console.log(`Adding ${streamsToAdd.length} new streams and updating ${streamsToUpdate.length} existing streams`);

            if (streamsToAdd.length > 0) {
                content.streams.push(...streamsToAdd);
            }
            
            content.lastUpdated = now;
            await inMemoryDB.save(content);
            
            console.log(`✅ Saved ${streamsToAdd.length + streamsToUpdate.length} streams to database`);
            return content.streams;
        });
    } catch (error) {
        if (error.name === 'AsyncLockTimeout') {
            console.error(`❌ Lock timeout, skipping save`);
            return [];
        }
        console.error('❌ Error merging and saving streams:', error);
        return [];
    }
}

// Cache checking function with proper Real-Debrid integration
async function checkCacheStatuses(service, streams) {
    if (!streams?.length) return {};

    try {
        const validStreams = streams.filter(stream => stream && stream.hash);
        if (!validStreams.length) return {};

        const hashes = validStreams.map(stream => stream.hash.toLowerCase());
        
        if (service.constructor.name === 'RealDebrid' || service.serviceName === 'RealDebrid') {
            return await checkRDCache(service, validStreams);
        } else {
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
        }
    } catch (error) {
        console.error('Cache check error:', error);
        return {};
    }
}

// MAIN STREAM ENDPOINT - Fixed to avoid API abuse while keeping functionality
app.get('/:apiKeys/stream/:type/:id.json', async (req, res) => {
    const { apiKeys, type, id } = req.params;
    
    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            throw new Error('No valid debrid service configured');
        }

        const standardId = standardizeId(id);
        
        let origId = standardId;
        let tmdbId = standardId;
        let season = null;
        let episode = null;

        if (type === 'series') {
            [tmdbId, season, episode] = standardId.split(':');
            origId = tmdbId;
        }

        const idType = getIdType(tmdbId);
        if (!idType) {
            console.error('Invalid ID format:', tmdbId);
            return res.json({ streams: [] });
        }

        let dbId = tmdbId;
        if (dbId.startsWith('tmdb:')) {
            dbId = dbId.replace('tmdb:', '');
        } else if (dbId.startsWith('tmdb-')) {
            dbId = dbId.replace('tmdb-', '');
        }

        console.log(`Processing ${idType.toUpperCase()} ID: ${tmdbId} (DB ID: ${dbId})`);

        const availableServices = debridServices.map(service => {
            if (service instanceof DebridLink) return 'debridlink';
            if (service instanceof Premiumize) return 'premiumize';
            if (service instanceof TorBox) return 'torbox';
            if (service instanceof RealDebrid || service.constructor.name === 'RealDebrid') return 'realdebrid';
            return null;
        }).filter(Boolean);
        
        console.log(`Available services: ${availableServices.join(', ')}`);

        // First, check what's in database
        const content = await readContentData(type, dbId, season, episode);
        let processedStreams = [];
        
        // If we have cached content, process it immediately and send response
        if (content && content.streams && content.streams.length > 0) {
            console.log(`\n✅ Found ${content.streams.length} streams in database`);
            
            const cachedStreams = [];
            
            content.streams.forEach(stream => {
                const cachedServices = availableServices.filter(
                    service => stream.cachedOn && stream.cachedOn[service]
                );
                
                if (cachedServices.length === 0) return;
                
                cachedServices.forEach(cachedService => {
                    cachedStreams.push(createStreamEntry(stream, cachedService, req));
                });
            });
            
            if (cachedStreams.length > 0) {
                processedStreams = groupAndSortStreams(cachedStreams);
                console.log(`\n✅ Sending ${processedStreams.length} cached streams immediately`);
                
                // Send response immediately with cached streams
                if (!res.headersSent) {
                    res.json({ streams: processedStreams.slice(0, 50) });
                }
                
                // If we have enough cached streams, we're done - NO FURTHER API CALLS
                if (processedStreams.length >= 20) {
                    return;
                }
            }
        }

        // Only if we don't have enough cached streams, fetch new ones
        if (processedStreams.length < 10) {
            console.log('\n📄 Fetching additional streams from APIs...');
            const newStreams = await getStreams(type, origId, season, episode);
            
            if (newStreams.length > 0) {
                console.log('Checking cache status with services...');
                
                // CRITICAL FIX: Only check cache for a limited number of streams to avoid API abuse
                const streamsToCheck = newStreams.slice(0, 50); // Limit to 50 streams max
                const uncheckedHashes = streamsToCheck.map(stream => stream.hash.toLowerCase());
                
                const cacheResults = {};
                
                // Check with each service but limit the scope
                for (const service of debridServices) {
                    try {
                        const serviceName = service instanceof DebridLink ? 'debridlink' :
                                          service instanceof Premiumize ? 'premiumize' :
                                          service instanceof TorBox ? 'torbox' : 
                                          service instanceof RealDebrid ? 'realdebrid' :
                                          service.constructor.name === 'RealDebrid' ? 'realdebrid' : null;
                        
                        if (!serviceName) continue;
                        
                        console.log(`Checking cache status with ${serviceName}...`);
                        
                        let results;
                        if (serviceName === 'realdebrid') {
                            results = await checkRDCache(service, streamsToCheck);
                        } else {
                            results = await service.checkCacheStatuses(uncheckedHashes);
                        }
                        
                        Object.entries(results).forEach(([hash, info]) => {
                            if (!cacheResults[hash]) cacheResults[hash] = {};
                            cacheResults[hash][serviceName] = info.cached;
                        });
                        
                        // Break after first successful service to avoid over-checking
                        break;
                        
                    } catch (error) {
                        console.error(`Error checking cache with service:`, error);
                        continue;
                    }
                }
                
                const defaultTitle = type === 'series' 
                    ? `Series ${dbId} S${season}E${episode}` 
                    : `Movie ${dbId}`;
                
                const streamsToSave = streamsToCheck.map(stream => {
                    const hash = stream.hash.toLowerCase();
                    const cachedOn = {
                        debridlink: cacheResults[hash]?.debridlink || false,
                        premiumize: cacheResults[hash]?.premiumize || false,
                        torbox: cacheResults[hash]?.torbox || false,
                        realdebrid: cacheResults[hash]?.realdebrid || false
                    };
                    
                    return {
                        ...stream,
                        hash,
                        cachedOn,
                        lastChecked: new Date()
                    };
                });
                
                await mergeAndSaveStreams(
                    type,
                    dbId,
                    streamsToSave,
                    streamsToCheck[0]?.filename || defaultTitle,
                    season,
                    episode
                );
                
                const newCachedStreams = [];
                
                streamsToCheck.forEach(stream => {
                    const hash = stream.hash.toLowerCase();
                    const cachedInfo = cacheResults[hash];
                    
                    if (!cachedInfo) return;
                    
                    const cachedServices = [];
                    
                    if (cachedInfo.debridlink) cachedServices.push('debridlink');
                    if (cachedInfo.premiumize) cachedServices.push('premiumize');
                    if (cachedInfo.torbox) cachedServices.push('torbox');
                    if (cachedInfo.realdebrid) cachedServices.push('realdebrid');
                    
                    if (cachedServices.length === 0) return;
                    
                    cachedServices.forEach(cachedService => {
                        newCachedStreams.push(createStreamEntry(stream, cachedService, req));
                    });
                });
                
                if (newCachedStreams.length > 0) {
                    processedStreams = [...processedStreams, ...newCachedStreams];
                    processedStreams = groupAndSortStreams(processedStreams);
                }
            }
        }

        if (!res.headersSent) {
            if (processedStreams.length > 0) {
                processedStreams = groupAndSortStreams(processedStreams);
            }
            console.log(`\n✅ Sending ${processedStreams.length} streams (final response)`);
            return res.json({ streams: processedStreams.slice(0, 50) });
        }

    } catch (error) {
        console.error('❌ Error processing streams:', error.message);
        if (!res.headersSent) {
            res.json({ streams: [] });
        }
    }
});

// ENHANCED MAGNET HANDLER - Fixed streaming issues
app.get('/:apiKeys/:magnetLink', async (req, res) => {
    const { apiKeys, magnetLink } = req.params;
    
    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            console.error('❌ No valid debrid service configured');
            return res.status(500).json({ error: 'No valid debrid service configured' });
        }

        console.log('\n🧲 Processing magnet request');
        const decodedMagnet = base64Decode(magnetLink);
        console.log('Decoded magnet:', decodedMagnet);
        
        const preferredService = decodedMagnet.match(/&service=([^&]+)/)?.[1];
        console.log('Preferred service:', preferredService || 'None specified');
        
        // Sort services to prioritize the preferred one
        if (preferredService) {
            debridServices.sort((a, b) => {
                const aIsPreferred = (a instanceof DebridLink && preferredService === 'debridlink') ||
                                   (a instanceof Premiumize && preferredService === 'premiumize') ||
                                   (a instanceof TorBox && preferredService === 'torbox') ||
                                   (a instanceof RealDebrid && preferredService === 'realdebrid') ||
                                   (a.constructor.name === 'RealDebrid' && preferredService === 'realdebrid');
                const bIsPreferred = (b instanceof DebridLink && preferredService === 'debridlink') ||
                                   (b instanceof Premiumize && preferredService === 'premiumize') ||
                                   (b instanceof TorBox && preferredService === 'torbox') ||
                                   (b instanceof RealDebrid && preferredService === 'realdebrid') ||
                                   (b.constructor.name === 'RealDebrid' && preferredService === 'realdebrid');
                
                if (aIsPreferred && !bIsPreferred) return -1;
                if (!aIsPreferred && bIsPreferred) return 1;
                return 0;
            });
            
            console.log('Service order after sorting:');
            debridServices.forEach(service => {
                if (service instanceof DebridLink) console.log('- DebridLink');
                else if (service instanceof Premiumize) console.log('- Premiumize');
                else if (service instanceof TorBox) console.log('- TorBox');
                else if (service instanceof RealDebrid || service.constructor.name === 'RealDebrid') console.log('- RealDebrid');
            });
        }
        
        // Remove service parameter from magnet link
        const cleanMagnet = decodedMagnet.replace(/&service=[^&]+/, '');
        console.log('Clean magnet:', cleanMagnet);

        const hash = extractInfoHash(cleanMagnet)?.toLowerCase();
        if (!hash) {
            throw new Error('Invalid magnet link - no BTIH hash found');
        }
        console.log(`Hash: ${hash}`);

        // Try each service in order with proper stream validation
        for (const service of debridServices) {
            try {
                let serviceName = 'Unknown';
                if (service instanceof DebridLink) serviceName = 'DebridLink';
                else if (service instanceof Premiumize) serviceName = 'Premiumize';
                else if (service instanceof TorBox) serviceName = 'TorBox';
                else if (service instanceof RealDebrid || service.constructor.name === 'RealDebrid') serviceName = 'RealDebrid';
                
                console.log(`Trying service: ${serviceName}`);
                
                // Use the improved getValidStreamingUrl logic
                const streamUrl = await getValidStreamingUrl(service, cleanMagnet, hash);
                
                if (!streamUrl) {
                    console.log(`❌ No valid stream URL from ${serviceName}`);
                    continue;
                }
                
                console.log(`✅ Success with ${serviceName}`);
                console.log(`Stream URL: ${streamUrl}`);
                
                // CRITICAL: Set proper headers for streaming
                res.set({
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Cache-Control': 'no-cache',
                    'X-Content-Type-Options': 'nosniff'
                });
                
                // Test the stream URL before redirecting
                try {
                    console.log(`🔍 Testing stream URL accessibility...`);
                    const testResponse = await fetch(streamUrl, { 
                        method: 'HEAD',
                        timeout: 5000,
                        redirect: 'follow'
                    });
                    
                    if (!testResponse.ok) {
                        console.log(`❌ Stream URL test failed: ${testResponse.status} ${testResponse.statusText}`);
                        continue;
                    }
                    
                    console.log(`✅ Stream URL test passed: ${testResponse.status}`);
                } catch (testError) {
                    console.log(`⚠️ Stream URL test failed, but continuing: ${testError.message}`);
                    // Continue anyway as some services block HEAD requests
                }
                
                // Use proper redirect with status code
                console.log(`🔄 Redirecting to stream URL...`);
                return res.redirect(302, streamUrl);
                
            } catch (error) {
                let serviceName = 'Unknown';
                if (service instanceof DebridLink) serviceName = 'DebridLink';
                else if (service instanceof Premiumize) serviceName = 'Premiumize';
                else if (service instanceof TorBox) serviceName = 'TorBox';
                else if (service instanceof RealDebrid || service.constructor.name === 'RealDebrid') serviceName = 'RealDebrid';
                
                console.error(`❌ ${serviceName} failed:`, error.message);
                
                // If it's a non-premium error, skip to next service
                if (error.message === ERROR.NOT_PREMIUM) {
                    console.log(`⚠️ Skipping non-premium ${serviceName}`);
                    continue;
                }
                
                // Continue to next service for other errors
                continue;
            }
        }

        // If we get here, all services failed
        console.error('❌ All debrid services failed');
        return res.status(500).json({ 
            error: 'All debrid services failed',
            details: 'No service could provide a stream URL for this magnet'
        });

    } catch (error) {
        console.error('❌ Error processing magnet:', error);
        return res.status(500).json({ 
            error: 'Failed to process magnet', 
            details: error.message 
        });
    }
});

// Add the getValidStreamingUrl function from your working version
async function getValidStreamingUrl(service, magnetLink, hash) {
    const serviceName = service.constructor.name;
    
    try {
        let streamUrl;
        
        if (service instanceof RealDebrid || service.constructor.name === 'RealDebrid') {
            // Check availability first for RealDebrid
            const availability = await service.checkInstantAvailability([hash]);
            if (!availability[hash]?.cached) {
                console.log(`❌ ${serviceName}: Not cached`);
                return null;
            }
            streamUrl = await service.getCachedUrl(magnetLink);
            
        } else if (service instanceof TorBox) {
            streamUrl = await service.getStreamUrl(magnetLink);
            
        } else if (service instanceof Premiumize) {
            streamUrl = await service.getStreamUrl(magnetLink);
            
        } else {
            streamUrl = await service.getStreamUrl(magnetLink);
        }
        
        // Simple URL validation
        if (!streamUrl || !streamUrl.startsWith('http')) {
            console.log(`❌ ${serviceName}: Invalid stream URL: ${streamUrl}`);
            return null;
        }
        
        console.log(`✅ ${serviceName}: Got valid streaming URL`);
        return streamUrl;
        
    } catch (error) {
        if (error.message === ERROR.NOT_PREMIUM) {
            console.log(`⚠️ ${serviceName}: Not premium`);
            return null;
        }
        if (error.message.includes('active download limit') || error.message.includes('ACTIVE_LIMIT')) {
            console.log(`⚠️ ${serviceName}: Download limit reached`);
            return null;
        }
        console.error(`❌ ${serviceName} error:`, error.message);
        return null;
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint to test stream URLs
app.get('/debug/:apiKeys/:magnetLink', async (req, res) => {
    const { apiKeys, magnetLink } = req.params;
    
    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            return res.json({ error: 'No valid debrid service configured' });
        }

        const decodedMagnet = base64Decode(magnetLink);
        const cleanMagnet = decodedMagnet.replace(/&service=[^&]+/, '');
        const hash = extractInfoHash(cleanMagnet)?.toLowerCase();
        
        const results = [];
        
        for (const service of debridServices) {
            let serviceName = 'Unknown';
            if (service instanceof DebridLink) serviceName = 'DebridLink';
            else if (service instanceof Premiumize) serviceName = 'Premiumize';
            else if (service instanceof TorBox) serviceName = 'TorBox';
            else if (service instanceof RealDebrid || service.constructor.name === 'RealDebrid') serviceName = 'RealDebrid';
            
            try {
                const streamUrl = await getValidStreamingUrl(service, cleanMagnet, hash);
                
                if (streamUrl) {
                    // Test the URL
                    try {
                        const testResponse = await fetch(streamUrl, { 
                            method: 'HEAD',
                            timeout: 5000 
                        });
                        
                        results.push({
                            service: serviceName,
                            streamUrl: streamUrl,
                            accessible: testResponse.ok,
                            status: testResponse.status,
                            headers: Object.fromEntries(testResponse.headers.entries())
                        });
                    } catch (testError) {
                        results.push({
                            service: serviceName,
                            streamUrl: streamUrl,
                            accessible: false,
                            error: testError.message
                        });
                    }
                } else {
                    results.push({
                        service: serviceName,
                        streamUrl: null,
                        error: 'No stream URL returned'
                    });
                }
            } catch (error) {
                results.push({
                    service: serviceName,
                    streamUrl: null,
                    error: error.message
                });
            }
        }
        
        res.json({
            magnet: cleanMagnet,
            hash: hash,
            results: results
        });
        
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('\n❌ Unhandled error:', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

const port = process.env.PORT || 9516;
app.listen(port, () => {
    console.log(`\n🚀 Addon running at http://localhost:${port}`);
    console.log(`📋 Configuration page: http://localhost:${port}/configure`);
});