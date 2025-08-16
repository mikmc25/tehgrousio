// Simple RealDebrid implementation for testing
export class RealDebrid {
    constructor(apiKey) {
        this.apiKey = apiKey.replace('rd=', '').trim();
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
        this.serviceName = 'RealDebrid';
    }

    static canHandle(apiKey) {
        return apiKey && apiKey.startsWith('rd=') && apiKey.length > 43;
    }

    async makeRequest(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${this.apiKey}`,
            'User-Agent': 'Stremio-Addon/1.0',
            ...options.headers
        };

        const response = await fetch(url, {
            method: 'GET',
            ...options,
            headers
        });

        if (!response.ok) {
            throw new Error(`RD API Error: ${response.status}`);
        }

        return response.json();
    }

    // Test API key
    async testApiKey() {
        try {
            await this.makeRequest('/user');
            return true;
        } catch (error) {
            console.error('RD API test failed:', error);
            return false;
        }
    }

    // Simple cache check - returns all as potentially cached since endpoint is disabled
    async checkInstantAvailability(hashes) {
        console.log(`🔍 RD: Checking ${hashes.length} hashes (endpoint disabled fallback)`);
        
        const results = {};
        hashes.forEach(hash => {
            results[hash.toLowerCase()] = {
                cached: true, // Show all as cached since we can't verify
                files: [],
                error: 'Cache status unknown - endpoint disabled'
            };
        });
        
        return results;
    }

    // Main method to get stream URL
    async getCachedUrl(magnetLink) {
        try {
            console.log('🧲 RD: Getting stream URL...');
            
            // Extract hash from magnet
            const hashMatch = magnetLink.match(/btih:([a-f0-9]{40})/i);
            if (!hashMatch) {
                throw new Error('Invalid magnet link');
            }

            // Step 1: Add magnet
            const addResponse = await this.makeRequest('/torrents/addMagnet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ magnet: magnetLink })
            });

            const torrentId = addResponse.id;
            console.log('✅ RD: Added torrent:', torrentId);

            // Step 2: Wait and get torrent info
            await this.delay(2000);
            const torrentInfo = await this.makeRequest(`/torrents/info/${torrentId}`);
            
            console.log('📊 RD: Torrent status:', torrentInfo.status);

            // Step 3: Handle different statuses
            if (torrentInfo.status === 'downloaded') {
                return await this.getDownloadLink(torrentId, torrentInfo);
            }
            
            if (torrentInfo.status === 'waiting_files_selection') {
                await this.selectVideoFiles(torrentId, torrentInfo);
                await this.delay(3000);
                const updatedInfo = await this.makeRequest(`/torrents/info/${torrentId}`);
                
                if (updatedInfo.status === 'downloaded') {
                    return await this.getDownloadLink(torrentId, updatedInfo);
                } else {
                    throw new Error('Torrent not cached - downloading required');
                }
            }
            
            throw new Error(`Torrent not ready: ${torrentInfo.status}`);

        } catch (error) {
            console.error('❌ RD: getCachedUrl failed:', error);
            throw error;
        }
    }

    // Select video files from torrent
    async selectVideoFiles(torrentId, torrentInfo) {
        const videoFiles = torrentInfo.files.filter(file => 
            this.isVideoFile(file.path) && file.bytes > 5 * 1024 * 1024 // > 5MB
        );

        if (videoFiles.length === 0) {
            throw new Error('No video files found');
        }

        const fileIds = videoFiles.map(file => file.id).join(',');
        
        await this.makeRequest(`/torrents/selectFiles/${torrentId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ files: fileIds })
        });

        console.log('✅ RD: Selected video files:', fileIds);
    }

    // Get download link for ready torrent
    async getDownloadLink(torrentId, torrentInfo) {
        // Find largest video file
        const videoFiles = torrentInfo.files.filter(file => 
            file.selected === 1 && this.isVideoFile(file.path)
        );

        if (videoFiles.length === 0) {
            throw new Error('No selected video files');
        }

        const largestFile = videoFiles.reduce((largest, current) => 
            current.bytes > largest.bytes ? current : largest
        );

        const fileIndex = torrentInfo.files.indexOf(largestFile);
        const downloadLink = torrentInfo.links[fileIndex];

        if (!downloadLink) {
            throw new Error('No download link available');
        }

        // Unrestrict the link
        const unrestrictResponse = await this.makeRequest('/unrestrict/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ link: downloadLink })
        });

        console.log('✅ RD: Got unrestricted link');
        return unrestrictResponse.download;
    }

    // Check if file is video
    isVideoFile(filename) {
        const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v'];
        return videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
    }

    // Simple delay helper
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Cleanup method
    async deleteTorrent(torrentId) {
        try {
            await this.makeRequest(`/torrents/delete/${torrentId}`, { method: 'DELETE' });
            console.log('🗑️ RD: Deleted torrent:', torrentId);
        } catch (error) {
            console.warn('⚠️ RD: Could not delete torrent:', error);
        }
    }
}