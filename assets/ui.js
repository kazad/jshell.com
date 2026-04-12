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
                <div class="pane-label">
                    <span class="text-[10px] font-extrabold tracking-widest uppercase text-text-muted">${label}</span>
                    <div class="flex gap-1.5">
                        ${showPaste ? `<button class="ui-action-btn" onclick="JShellUI.paste('${containerId}')">${JShellUI.svg('paste')} Paste</button>` : ''}
                        ${showClear ? `<button class="ui-action-btn" onclick="JShellUI.clear('${containerId}')">${JShellUI.svg('clear')} Clear</button>` : ''}
                        ${showCopy ? `<button class="ui-action-btn action-copy" onclick="JShellUI.copy('${containerId}')">${JShellUI.svg('copy')} <span>Copy</span></button>` : ''}
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

    // SVG icons (Heroicons)
    svg(type) {
        const icons = {
            copy: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>`,
            paste: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>`,
            clear: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>`,
            check: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M4.5 12.75l6 6 9-13.5" /></svg>`
        };
        return icons[type] || '';
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
            const span = btn.querySelector('span');
            const originalIcon = btn.innerHTML;
            
            btn.innerHTML = `${JShellUI.svg('check')} <span class="text-success">Copied!</span>`;
            btn.classList.add('text-success');

            setTimeout(() => {
                btn.innerHTML = originalIcon;
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
// v1.0.1
