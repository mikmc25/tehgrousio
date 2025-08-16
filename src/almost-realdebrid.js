// RealDebrid service implementation for debrids.js
export class RealDebrid {
    constructor(apiKey) {
        this.apiKey = apiKey.replace('rd=', ''); // Remove prefix like other services
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('rd=');
    }

    async makeRequest(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${this.apiKey}`,
            ...options.headers
        };

        try {
            console.log(`🌐 RealDebrid API call: ${options.method || 'GET'} ${endpoint}`);
            const response = await fetch(url, { ...options, headers });

            console.log(`📡 Response status: ${response.status} ${response.statusText}`);

            if (response.status >= 400) {
                if (response.status === 401) throw new Error('NOT_PREMIUM');
                if (response.status === 403) throw new Error('INVALID_API_KEY');
                throw new Error(`RealDebrid API error: ${response.status} - ${response.statusText}`);
            }

            try {
                const text = await response.text();
                return text.trim() ? JSON.parse(text) : {};
            } catch {
                return {};
            }
        } catch (error) {
            console.error(`❌ RealDebrid API request failed:`, error.message);
            throw error;
        }
    }

    async checkInstantAvailability(hashes) {
        if (!hashes || hashes.length === 0) return {};

        try {
            console.log(`🔍 RealDebrid: Checking cache status for ${hashes.length} hashes`);
            const endpoint = `/torrents/instantAvailability/${hashes.join('/')}`;
            const response = await this.makeRequest(endpoint);
            console.log(`✅ RealDebrid: Received response for cache check`);

            const results = {};
            hashes.forEach(hash => {
                const lower = hash.toLowerCase();
                const data = response[lower];
                const isCached = data && typeof data === 'object' && Object.keys(data).length > 0;

                results[lower] = {
                    cached: isCached,
                    files: isCached ? this.extractVideoFiles(data) : [],
                    service: 'RealDebrid'
                };

                console.log(`Hash ${lower}: ${isCached ? 'CACHED' : 'NOT CACHED'}`);
            });

            const cachedCount = Object.values(results).filter(r => r.cached).length;
            console.log(`🎯 RealDebrid: ${cachedCount}/${hashes.length} hashes are cached`);
            return results;

        } catch (error) {
            console.error('❌ RealDebrid cache check error:', error);
            return Object.fromEntries(hashes.map(h => [h.toLowerCase(), {
                cached: false,
                files: [],
                service: 'RealDebrid'
            }]));
        }
    }

    extractVideoFiles(torrentData) {
        const files = [];
        try {
            Object.values(torrentData).forEach(variant => {
                if (Array.isArray(variant)) {
                    variant.forEach(file => {
                        if (this.isVideoFile(file.filename)) {
                            files.push({
                                id: file.id,
                                filename: file.filename,
                                filesize: file.filesize
                            });
                        }
                    });
                }
            });
        } catch (err) {
            console.error('Error extracting video files:', err);
        }
        return files;
    }

    isVideoFile(filename) {
        if (!filename) return false;
        const ext = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.ogv', '.ts', '.m2ts', '.mts'];
        return ext.some(e => filename.toLowerCase().endsWith(e));
    }

    async getCachedUrl(magnetLink) {
        try {
            console.log('🧲 RealDebrid: Processing magnet link');

            // Extract info hash
            const hashMatch = magnetLink.match(/btih:([a-fA-F0-9]+)/);
            const hash = hashMatch ? hashMatch[1].toLowerCase() : null;
            if (!hash) throw new Error('Invalid magnet link - missing hash');

            // ✅ Pre-check for caching
            const availability = await this.checkInstantAvailability([hash]);
            const isCached = availability[hash]?.cached;

            if (!isCached) {
                console.warn('❌ RealDebrid: Torrent not cached, aborting');
                return null;
            }

            // Add magnet
            const form = new URLSearchParams();
            form.append('magnet', magnetLink);
            const addResponse = await this.makeRequest('/torrents/addMagnet', {
                method: 'POST',
                body: form
            });

            const torrentId = addResponse?.id;
            if (!torrentId) throw new Error('Failed to add magnet');

            console.log(`✅ RealDebrid: Added torrent with ID: ${torrentId}`);

            // Get torrent info
            const torrentInfo = await this.makeRequest(`/torrents/info/${torrentId}`);
            if (!torrentInfo?.files?.length) throw new Error('No files found in torrent');

            console.log(`📁 RealDebrid: Found ${torrentInfo.files.length} files in torrent`);

            // Select files
            const selectForm = new URLSearchParams();
            selectForm.append('files', 'all');
            await this.makeRequest(`/torrents/selectFiles/${torrentId}`, {
                method: 'POST',
                body: selectForm
            });

            console.log('✅ RealDebrid: Selected all files for download');

            const updatedInfo = await this.makeRequest(`/torrents/info/${torrentId}`);
            if (updatedInfo.status !== 'downloaded' || !updatedInfo.links?.length) {
                throw new Error('Torrent marked as cached, but not ready');
            }

            const videoFiles = updatedInfo.files?.filter(file => this.isVideoFile(file.path)) || [];
            if (!videoFiles.length) throw new Error('No video files found');

            videoFiles.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
            const selectedFile = videoFiles[0];

            console.log(`🎬 RealDebrid: Selected file: ${selectedFile.path} (${((selectedFile.bytes || 0) / 1024 / 1024 / 1024).toFixed(2)} GB)`);

            const unrestrictForm = new URLSearchParams();
            unrestrictForm.append('link', updatedInfo.links[0]);

            const unrestrictResponse = await this.makeRequest('/unrestrict/link', {
                method: 'POST',
                body: unrestrictForm
            });

            const directUrl = unrestrictResponse?.download;
            if (!directUrl) throw new Error('Failed to get direct URL');

            console.log('🎯 RealDebrid: Got direct stream URL');
            return directUrl;

        } catch (error) {
            console.error('❌ RealDebrid getCachedUrl error:', error.message);
            return null;
        }
    }
}
