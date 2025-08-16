app.get('/:apiKeys/:magnetLink', async (req, res) => {
    const { apiKeys, magnetLink } = req.params;

    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            throw new Error('No valid debrid service configured');
        }

        console.log('\n🧲 Processing magnet request');
        const decodedMagnet = base64Decode(magnetLink);
        const hash = extractInfoHash(decodedMagnet)?.toLowerCase();

        if (!hash) {
            throw new Error('Invalid magnet link - no BTIH hash found');
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

        // Track which services failed and why
        const serviceErrors = [];

        for (const service of debridServices) {
            try {
                const serviceName = service.constructor.name;
                console.log(`Trying service: ${serviceName}`);

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
                        serviceErrors.push(`${serviceName}: No cached URL`);
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

        // If we get here, no service could provide the stream
        // Return a special error stream that Stremio can handle
        console.log('❌ No cached stream available from any debrid service');
        console.log('Service errors:', serviceErrors);

        // Return an error "stream" that will cause Stremio to show an error and return to sources
        return res.status(404).json({ 
            error: 'Stream not available',
            message: 'This content is not cached on any of your debrid services',
            details: serviceErrors.join(', '),
            // This header helps Stremio understand it's a stream error
            headers: {
                'Content-Type': 'application/json'
            }
        });

    } catch (error) {
        console.error('❌ Error processing magnet:', error.message);
        
        // Always return a structured error response
        return res.status(404).json({ 
            error: 'Stream not available', 
            message: 'Unable to process stream request',
            details: error.message,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }
});