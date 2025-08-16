// RealDebrid implementation based on working Torrentio code
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
            method: options.method || 'GET',
            timeout: 15000,
            ...options,
            headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorObj;
            try {
                errorObj = JSON.parse(errorText);
            } catch {
                errorObj = { error: errorText, code: response.status };
            }
            throw errorObj;
        }

        return response.json();
    }

    // Test API key
    async testApiKey() {
        try {
            const user = await this.makeRequest('/user');
            console.log('✅ RD API key valid for user:', user.username);
            return true;
        } catch (error) {
            console.error('❌ RD API test failed:', error);
            return false;
        }
    }

    // Cache check - mark all as cached since endpoint is disabled
    async checkInstantAvailability(hashes) {
        console.log(`🔍 RD: Checking ${hashes.length} hashes (fallback - endpoint disabled)`);
        
        const results = {};
        hashes.forEach(hash => {
            results[hash.toLowerCase()] = {
                cached: true,
                files: []
            };
        });
        
        return results;
    }

    // Main method to get stream URL - based on Torrentio's _resolve function
    async getCachedUrl(magnetLink) {
        try {
            console.log('🧲 RD: Processing magnet link...');
            
            // Extract hash from magnet
            const hashMatch = magnetLink.match(/btih:([a-f0-9]{40})/i);
            if (!hashMatch) {
                throw new Error('Invalid magnet link format');
            }
            const infoHash = hashMatch[1].toLowerCase();

            // Step 1: Create or find existing torrent
            const torrentId = await this.createOrFindTorrentId(infoHash, magnetLink);
            console.log('✅ RD: Got torrent ID:', torrentId);

            // Step 2: Get torrent info
            const torrent = await this.getTorrentInfo(torrentId);
            console.log('📊 RD: Torrent status:', torrent.status);

            // Step 3: Handle different statuses
            if (this.statusReady(torrent.status)) {
                return await this.unrestrictLink(torrent);
            } else if (this.statusDownloading(torrent.status)) {
                throw new Error('Torrent is downloading - not cached');
            } else if (this.statusWaitingSelection(torrent.status)) {
                console.log('🎯 RD: Selecting files...');
                await this.selectTorrentFiles(torrent);
                
                // Wait and check again
                await this.delay(3000);
                const updatedTorrent = await this.getTorrentInfo(torrentId);
                
                if (this.statusReady(updatedTorrent.status)) {
                    return await this.unrestrictLink(updatedTorrent);
                } else {
                    throw new Error('Torrent not cached - downloading required');
                }
            } else {
                throw new Error(`Torrent not ready: ${torrent.status}`);
            }

        } catch (error) {
            console.error('❌ RD: getCachedUrl failed:', error);
            throw error;
        }
    }

    // Create or find existing torrent (from Torrentio)
    async createOrFindTorrentId(infoHash, magnetLink) {
        try {
            return await this.findTorrent(infoHash);
        } catch {
            return await this.createTorrentId(infoHash, magnetLink);
        }
    }

    // Find existing torrent
    async findTorrent(infoHash) {
        const torrents = await this.makeRequest('/torrents?page=1&limit=50');
        const foundTorrent = torrents.find(torrent => 
            torrent.hash.toLowerCase() === infoHash && 
            !this.statusError(torrent.status)
        );
        
        if (!foundTorrent) {
            throw new Error('No recent torrent found');
        }
        
        return foundTorrent.id;
    }

    // Create new torrent
    async createTorrentId(infoHash, magnetLink) {
        console.log('🔗 RD: Adding magnet to account...');
        
        const addResponse = await this.makeRequest('/torrents/addMagnet', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ 
                magnet: magnetLink 
            }).toString()
        });

        return addResponse.id;
    }

    // Get torrent info
    async getTorrentInfo(torrentId) {
        return await this.makeRequest(`/torrents/info/${torrentId}`);
    }

    // Select video files from torrent (based on Torrentio)
    async selectTorrentFiles(torrent) {
        if (!this.statusWaitingSelection(torrent.status)) {
            return torrent;
        }

        const videoFiles = torrent.files.filter(file => 
            this.isVideoFile(file.path) && file.bytes > 5 * 1024 * 1024 // > 5MB
        );

        if (videoFiles.length === 0) {
            throw new Error('No video files found');
        }

        const fileIds = videoFiles.map(file => file.id).join(',');
        
        await this.makeRequest(`/torrents/selectFiles/${torrent.id}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ 
                files: fileIds 
            }).toString()
        });

        console.log('✅ RD: Selected video files:', fileIds);
        return torrent;
    }

    // Unrestrict link to get final download URL (based on Torrentio)
    async unrestrictLink(torrent) {
        // Find largest selected video file
        const selectedVideoFiles = torrent.files.filter(file => 
            file.selected === 1 && this.isVideoFile(file.path)
        );

        if (selectedVideoFiles.length === 0) {
            throw new Error('No selected video files found');
        }

        const largestFile = selectedVideoFiles.reduce((largest, current) => 
            current.bytes > largest.bytes ? current : largest
        );

        // Get the corresponding download link
        const fileIndex = torrent.files.indexOf(largestFile);
        const downloadLink = torrent.links[fileIndex];

        if (!downloadLink) {
            throw new Error('No download link available for selected file');
        }

        // Unrestrict the link
        console.log('🔓 RD: Unrestricting download link...');
        const unrestrictResponse = await this.makeRequest('/unrestrict/link', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ 
                link: downloadLink 
            }).toString()
        });

        console.log('✅ RD: Got unrestricted link');
        return unrestrictResponse.download;
    }

    // Status check helpers (from Torrentio)
    statusError(status) {
        return ['error', 'magnet_error'].includes(status);
    }

    statusWaitingSelection(status) {
        return status === 'waiting_files_selection';
    }

    statusDownloading(status) {
        return ['downloading', 'uploading', 'queued'].includes(status);
    }

    statusReady(status) {
        return ['downloaded', 'dead'].includes(status);
    }

    // Check if file is video
    isVideoFile(filename) {
        const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.ts', '.m2ts'];
        return videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
    }

    // Simple delay helper
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}