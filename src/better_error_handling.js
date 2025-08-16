// Add this new endpoint for handling stream errors
app.get('/:apiKeys/error/:message', (req, res) => {
    const { message } = req.params;
    const decodedMessage = decodeURIComponent(message);
    
    // Return a simple HTML page that Stremio can display
    res.set('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Stream Not Available</title>
            <meta charset="utf-8">
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    text-align: center; 
                    padding: 50px; 
                    background: #000; 
                    color: #fff; 
                }
                .error { 
                    font-size: 24px; 
                    margin-bottom: 20px; 
                    color: #ff6b6b; 
                }
                .message { 
                    font-size: 16px; 
                    margin-bottom: 30px; 
                    color: #ccc; 
                }
                .close-btn {
                    background: #ff6b6b;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    font-size: 16px;
                    border-radius: 5px;
                    cursor: pointer;
                }
            </style>
            <script>
                // Auto-close after 3 seconds to return to sources
                setTimeout(() => {
                    if (window.parent) {
                        window.parent.postMessage('close', '*');
                    } else {
                        window.close();
                    }
                }, 3000);
            </script>
        </head>
        <body>
            <div class="error">⚠️ Stream Not Available</div>
            <div class="message">${decodedMessage}</div>
            <div style="font-size: 14px; color: #666;">
                Returning to sources in 3 seconds...
            </div>
        </body>
        </html>
    `);
});

// Updated magnet handler
app.get('/:apiKeys/:magnetLink', async (req, res) => {
    const { apiKeys, magnetLink } = req.params;

    try {
        const debridServices = getDebridServices(apiKeys);
        if (!debridServices.length) {
            // Redirect to error page instead of throwing
            const errorMsg = encodeURIComponent('No valid debrid service configured');
            return res.redirect(`/${apiKeys}/error/${errorMsg}`);
        }

        console.log('\n🧲 Processing magnet request');
        const decodedMagnet = base64Decode(magnetLink);
        const hash = extractInfoHash(decodedMagnet)?.toLowerCase();

        if (!hash) {
            const errorMsg = encodeURIComponent('Invalid magnet link - no hash found');
            return res.redirect(`/${apiKeys}/error/${errorMsg}`);
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
                        serviceErrors.push(`${serviceName}: No cached URL available`);
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
        console.log('❌ No cached stream available from any debrid service');
        console.log('Service errors:', serviceErrors);

        // Redirect to error page with a user-friendly message
        const errorMsg = encodeURIComponent(
            'Content not cached on your debrid services. ' + 
            serviceErrors.join(', ')
        );
        return res.redirect(`/${apiKeys}/error/${errorMsg}`);

    } catch (error) {
        console.error('❌ Error processing magnet:', error.message);
        
        // Redirect to error page instead of JSON response
        const errorMsg = encodeURIComponent(`Stream processing failed: ${error.message}`);
        return res.redirect(`/${apiKeys}/error/${errorMsg}`);
    }
});