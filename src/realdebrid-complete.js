class RealDebrid {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
    }

    static canHandle(service) {
        return service.toLowerCase() === 'realdebrid' || service.toLowerCase() === 'rd';
    }

    async makeRequest(endpoint, method = 'GET', data = null) {
        const url = `${this.baseUrl}${endpoint}`;
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'User-Agent': 'Stremio-Addon/1.0'
            },
            timeout: 30000
        };

        if (data && method !== 'GET') {
            const formData = new URLSearchParams();
            Object.keys(data).forEach(key => {
                formData.append(key, data[key]);
            });
            options.body = formData;
        }

        console.log(`🌐 RealDebrid API call: ${method} ${endpoint}`);
        
        const response = await fetch(url, options);
        console.log(`📡 Response status: ${response.status} ${response.statusText}`);
        
        if (response.status < 400) {
            const text = await response.text();
            if (text.trim() === '') {
                return {};
            }
            try {
                return JSON.parse(text);
            } catch (e) {
                return { raw: text };
            }
        } else {
            const errorText = await response.text();
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }
    }

    async checkInstantAvailability(magnetLink) {
        try {
            const hash = this.extractHashFromMagnet(magnetLink);
            if (!hash) {
                return [];
            }

            const response = await this.makeRequest(`/torrents/instantAvailability/${hash}`);
            
            if (response && response[hash]) {
                const availableFiles = response[hash];
                return Object.keys(availableFiles).map(key => ({
                    id: key,
                    files: availableFiles[key]
                }));
            }
            
            return [];
        } catch (error) {
            console.log(`❌ RealDebrid availability check failed: ${error.message}`);
            return [];
        }
    }

    async getCachedUrl(magnetLink) {
        try {
            console.log('🧲 RealDebrid: Processing magnet link');
            
            // Add torrent
            const addResponse = await this.makeRequest('/torrents/addMagnet', 'POST', {
                magnet: magnetLink
            });

            if (!addResponse || !addResponse.id) {
                throw new Error('Failed to add torrent');
            }

            const torrentId = addResponse.id;
            console.log(`✅ RealDebrid: Added torrent with ID: ${torrentId}`);

            // Get torrent info and select files
            let torrentInfo = await this.makeRequest(`/torrents/info/${torrentId}`);
            
            if (!torrentInfo || !torrentInfo.files) {
                throw new Error('Failed to get torrent info');
            }

            console.log(`📁 RealDebrid: Found ${torrentInfo.files.length} files in torrent`);

            // Select all files
            const fileIds = torrentInfo.files.map((_, index) => index + 1).join(',');
            await this.makeRequest(`/torrents/selectFiles/${torrentId}`, 'POST', {
                files: fileIds
            });
            console.log('✅ RealDebrid: Selected all files for download');

            // Wait for download completion
            let attempts = 0;
            const maxAttempts = 60;
            
            while (attempts < maxAttempts) {
                torrentInfo = await this.makeRequest(`/torrents/info/${torrentId}`);
                
                console.log(`⏳ RealDebrid: Status: ${torrentInfo.status}, Progress: ${torrentInfo.progress}%, Links: ${torrentInfo.links ? torrentInfo.links.length : 0}`);

                if (torrentInfo.status === 'downloaded' && torrentInfo.links && torrentInfo.links.length > 0) {
                    console.log('✅ RealDebrid: Torrent is ready for streaming');
                    break;
                }

                if (torrentInfo.status === 'error' || torrentInfo.status === 'virus' || torrentInfo.status === 'dead') {
                    throw new Error(`Torrent failed with status: ${torrentInfo.status}`);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
                attempts++;
            }

            if (!torrentInfo.links || torrentInfo.links.length === 0) {
                throw new Error('Torrent download timed out or failed');
            }

            // Find the largest video file
            const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
            const videoFiles = torrentInfo.files.filter(file => 
                videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext))
            );

            let selectedFile = videoFiles.length > 0 ? 
                videoFiles.reduce((largest, current) => current.bytes > largest.bytes ? current : largest) :
                torrentInfo.files[0];

            console.log(`🎬 RealDebrid: Selected file: ${selectedFile.path} (${(selectedFile.bytes / 1024 / 1024 / 1024).toFixed(2)} GB)`);

            // Get the corresponding download link
            const downloadLink = torrentInfo.links[selectedFile.id - 1];
            if (!downloadLink) {
                throw new Error('No download link found for selected file');
            }

            // Unrestrict the link to get direct URL
            const unrestrictResponse = await this.makeRequest('/unrestrict/link', 'POST', {
                link: downloadLink
            });

            if (!unrestrictResponse) {
                throw new Error('Failed to unrestrict download link');
            }

            const streamUrl = unrestrictResponse.download || unrestrictResponse.link;
            
            if (!streamUrl) {
                console.log('❌ RealDebrid unrestrict response:', JSON.stringify(unrestrictResponse, null, 2));
                throw new Error('No stream URL in unrestrict response');
            }

            console.log('🎯 RealDebrid: Got direct stream URL');
            
            return {
                url: streamUrl,
                title: selectedFile.path.split('/').pop(),
                size: selectedFile.bytes
            };

        } catch (error) {
            console.log(`❌ RealDebrid getCachedUrl error: ${error.message}`);
            throw error;
        }
    }

    extractHashFromMagnet(magnetLink) {
        const match = magnetLink.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-fA-F0-9]{32})/);
        return match ? match[1].toLowerCase() : null;
    }
}

export { RealDebrid };