/**
 * JShell UI Components
 * Standardizes the look and behavior of editor/output panels
 */
const JShellUI = {
    // Initialize a panel with standard actions
    initPanel(containerId, options = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const type = options.type || 'editor'; // 'editor' or 'output'
        const label = options.label || (type === 'editor' ? 'Input' : 'Output');
        const showCopy = options.copy !== false;
        const showClear = options.clear !== false;
        const showPaste = type === 'editor' && options.paste !== false;

        // Extract the existing content (usually a textarea or pre)
        const content = container.innerHTML;
        
        // Rebuild with standard structure
        container.innerHTML = `
            <div class="jshell-panel h-full flex flex-col">
                <div class="editor-label flex justify-between items-center px-4 py-1.5 bg-bg border-b border-border">
                    <span class="text-[10px] font-extrabold tracking-widest uppercase text-text-muted">${label}</span>
                    <div class="flex gap-2">
                        ${showPaste ? `<button class="ui-action-btn" onclick="JShellUI.paste('${containerId}')">Paste</button>` : ''}
                        ${showClear ? `<button class="ui-action-btn" onclick="JShellUI.clear('${containerId}')">Clear</button>` : ''}
                        ${showCopy ? `<button class="ui-action-btn action-copy" onclick="JShellUI.copy('${containerId}')">Copy</button>` : ''}
                    </div>
                </div>
                <div class="flex-grow relative overflow-hidden bg-black panel-content-area">
                    ${content}
                </div>
            </div>
        `;

        // Ensure the internal textarea/pre fills the container
        const internal = container.querySelector('textarea, pre, div.output-content');
        if (internal) {
            internal.classList.add('w-full', 'h-full', 'p-5', 'bg-transparent', 'outline-none', 'resize-none');
        }
    },

    // Action: Copy
    async copy(containerId) {
        const container = document.getElementById(containerId);
        const target = container.querySelector('textarea, pre, code, .monospace');
        const text = target.tagName === 'TEXTAREA' ? target.value : target.textContent;
        
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            const btn = container.querySelector('.action-copy');
            const original = btn.textContent;
            btn.textContent = 'COPIED!';
            btn.classList.add('text-success');
            setTimeout(() => {
                btn.textContent = original;
                btn.classList.remove('text-success');
            }, 1500);
        } catch (err) {
            console.error('Failed to copy!', err);
        }
    },

    // Action: Clear
    clear(containerId) {
        const container = document.getElementById(containerId);
        const target = container.querySelector('textarea');
        if (target) {
            target.value = '';
            target.dispatchEvent(new Event('input'));
            target.focus();
        }
    },

    // Action: Paste
    async paste(containerId) {
        const container = document.getElementById(containerId);
        const target = container.querySelector('textarea');
        if (target) {
            const text = await navigator.clipboard.readText();
            target.value = text;
            target.dispatchEvent(new Event('input'));
        }
    }
};

window.JShellUI = JShellUI;
