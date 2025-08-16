// realdebrid.js — RealDebrid API client for hash-only caching

export class RealDebrid {
    constructor(apiKey) {
        this.apiKey = apiKey.replace('rd=', '');
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

            const response = await fetch(url, {
                ...options,
                headers
            });

            console.log(`📡 Response status: ${response.status} ${response.statusText}`);

            if (response.status === 401) throw new Error('INVALID_API_KEY');
            if (response.status === 403) throw new Error('INVALID_API_KEY');
            if (response.status === 429) throw new Error('TOO_MANY_REQUESTS');
            if (response.status >= 400) throw new Error(`RealDebrid API error: ${response.status} - ${response.statusText}`);

            const responseText = await response.text();
            if (!responseText.trim()) return {};
            return JSON.parse(responseText);

        } catch (error) {
            console.error(`❌ RealDebrid API request failed:`, error.message);
            throw error;
        }
    }

    async checkInstantAvailability(hashes) {
        if (!hashes || hashes.length === 0) return {};

        const results = {};
        const hashesParam = hashes.join('/');

        try {
            const endpoint = `/torrents/instantAvailability/${hashesParam}`;
            const response = await this.makeRequest(endpoint);
            console.log(`✅ RealDebrid: Received response for cache check`);

            hashes.forEach(hash => {
                const hashLower = hash.toLowerCase();
                const data = response?.[hashLower];
                const isCached = data && typeof data === 'object' && Object.keys(data).length > 0;

                results[hashLower] = {
                    cached: isCached,
                    files: isCached ? this.extractVideoFiles(data) : [],
                    service: 'RealDebrid'
                };

                console.log(`Hash ${hashLower}: ${isCached ? 'CACHED' : 'NOT CACHED'}`);
            });

            return results;

        } catch (error) {
            console.error('❌ RealDebrid cache check error:', error.message);
            hashes.forEach(hash => {
                results[hash.toLowerCase()] = {
                    cached: false,
                    files: [],
                    service: 'RealDebrid'
                };
            });
            return results;
        }
    }

    extractVideoFiles(torrentData) {
        const videoFiles = [];

        try {
            Object.values(torrentData).forEach(variant => {
                if (Array.isArray(variant)) {
                    variant.forEach(file => {
                        if (this.isVideoFile(file.filename)) {
                            videoFiles.push({
                                id: file.id,
                                filename: file.filename,
                                filesize: file.filesize
                            });
                        }
                    });
                }
            });
        } catch (error) {
            console.error('Error extracting video files from RealDebrid data:', error.message);
        }

        return videoFiles;
    }

    isVideoFile(filename) {
        if (!filename) return false;
        const videoExtensions = [
            '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
            '.m4v', '.3gp', '.ogv', '.ts', '.m2ts', '.mts'
        ];
        const lowerFilename = filename.toLowerCase();
        return videoExtensions.some(ext => lowerFilename.endsWith(ext));
    }
}
