/**
 * JShell State Management
 * Handles encoding/decoding tool state into the URL hash
 * Uses LZString for compression if available, falls back to Base64
 */
const JShellState = {
    // Encode object to Compressed String or Base64
    encode(obj) {
        const str = JSON.stringify(obj);
        
        if (window.LZString) {
            return 'z' + LZString.compressToEncodedURIComponent(str);
        }

        // Fallback to Base64 (Unicode support)
        return 'b' + btoa(unescape(encodeURIComponent(str)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    },

    // Decode String to object
    decode(encoded) {
        if (!encoded) return null;
        
        try {
            const type = encoded.charAt(0);
            const data = encoded.substring(1);

            if (type === 'z' && window.LZString) {
                const decompressed = LZString.decompressFromEncodedURIComponent(data);
                return JSON.parse(decompressed);
            }

            if (type === 'b' || !['z', 'b'].includes(type)) {
                // Legacy or explicit base64
                const b64 = (type === 'b' ? data : encoded)
                    .replace(/-/g, '+')
                    .replace(/_/g, '/');
                let pad = b64;
                while (pad.length % 4) pad += '=';
                const str = decodeURIComponent(escape(atob(pad)));
                return JSON.parse(str);
            }
        } catch (e) {
            console.error("Failed to decode state:", e);
        }
        return null;
    },

    // Get current state from URL hash
    load() {
        const hash = window.location.hash.substring(1);
        return this.decode(hash);
    },

    // Save state to URL hash without jumping/scrolling
    save(obj) {
        const encoded = this.encode(obj);
        window.history.replaceState(null, null, '#' + encoded);
    },

    // Copy full URL to clipboard
    copyLink() {
        const url = window.location.href;
        navigator.clipboard.writeText(url).then(() => {
            const btn = document.querySelector('.btn-stateless') || 
                        document.querySelector('.btn.primary') ||
                        document.querySelector('[onclick*="copyLink"]');
            
            if (btn) {
                const originalText = btn.textContent;
                btn.textContent = "COPIED WITH DATA!";
                btn.classList.add('text-success');
                setTimeout(() => { 
                    btn.textContent = originalText; 
                    btn.classList.remove('text-success');
                }, 2000);
            }
        });
    }
};

// Export to window for easy access in scripts
window.JShellState = JShellState;
