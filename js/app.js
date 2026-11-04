/**
 * SFChat - 云崽对话界面
 * 主应用模块
 */

// ========== 连接配置 ==========
// 页面以 https 打开时，浏览器会拦截 ws:// 明文连接（混合内容），需要浏览器放行：
//   · 桌面 Chrome / Edge：地址栏图标 → 网站设置 → 不安全内容 → 允许
//   · Android Chrome / Edge：flags 页搜 insecure，把 ws://你的IP:端口 填进
//     "Insecure origins treated as secure"（多个地址用英文逗号分隔）并启用
// 留空 = 直接用设置面板里填的 IP:端口 直连。
// 也可以写死一个完整地址（例如将来切换到 wss 入口）：'wss://ws.your-domain.com'
const WS_DIRECT_URL = '';

// ========== 版本信息 ==========
// 改 app.js / main.css 时同步更新：这里、index.html 的 ?v=、sw.js 的 CACHE_NAME
const APP_VERSION = '1.6.0';
const APP_BUILD = '2026-11-04 19:45';

// ========== 全局状态 ==========
const AppState = {
    wsConnection: null,
    wsConnected: false,
    wsAuthenticated: false,
    autoReconnectTimer: null,
    lastUserMessageElement: null,
    RECONNECT_INTERVAL: 5000
};

// ========== DOM元素缓存 ==========
const DOM = {
    chatContainer: null,
    messageInput: null,
    sendButton: null,
    settingsButton: null,
    settingsModal: null,
    modalOverlay: null,
    imagePreviewContainer: null,
    messagesArea: null,
    init() {
        this.chatContainer = document.querySelector('.chat-container');
        this.messageInput = document.getElementById('message-input');
        this.sendButton = document.getElementById('send-button');
        this.settingsButton = document.getElementById('settings-button');
        this.settingsModal = document.getElementById('settings-modal');
        this.modalOverlay = document.getElementById('modal-overlay');
        this.imagePreviewContainer = document.getElementById('image-preview-container');
        this.messagesArea = document.getElementById('messages-area');
    }
};

// ========== 工具函数 ==========
const Utils = {
    // 显示Toast消息
    showToast(message, duration = 2000) {
        const toast = document.getElementById('message-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), duration);
    },

    // 显示确认对话框
    showConfirm(message) {
        return new Promise((resolve) => {
            const dialog = document.getElementById('confirm-dialog');
            const overlay = DOM.modalOverlay;
            if (!dialog) return resolve(false);
            
            dialog.querySelector('.message').textContent = message;
            dialog.classList.add('show');
            overlay.classList.add('active');
            
            const confirmBtn = dialog.querySelector('.confirm-btn');
            const cancelBtn = dialog.querySelector('.cancel-btn');
            
            const cleanup = () => {
                dialog.classList.remove('show');
                overlay.classList.remove('active');
                confirmBtn.onclick = null;
                cancelBtn.onclick = null;
            };
            
            confirmBtn.onclick = () => { cleanup(); resolve(true); };
            cancelBtn.onclick = () => { cleanup(); resolve(false); };
            overlay.onclick = () => { cleanup(); resolve(false); };
        });
    },

    // 自动调整输入框高度
    autoResizeInput(textarea) {
        if (textarea.value.trim() === '') {
            textarea.style.height = '40px';
            return;
        }
        textarea.style.height = '40px';
        const newHeight = Math.max(40, Math.min(textarea.scrollHeight, 120));
        textarea.style.height = newHeight + 'px';
    },

    // 复制到剪贴板
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.error('复制失败:', err);
            return false;
        }
    }
};

// ========== 服务端媒体（仅当前页面会话，不持久化） ==========
// 历史消息完全由后端提供：Redis 里存 media:<id> 引用，页面按需通过 getMedia 拉取。
// 这里只缓存本次会话已经拉到的 dataUrl，刷新或换浏览器会重新向后端取，
// 浏览器不再保存任何聊天记录，也不会再根据内容猜哪张图属于哪条消息。
const ServerMedia = {
    cache: new Map(),
    requests: new Map(),
    watched: new Map(),
    REQUEST_TIMEOUT: 8000,

    MEDIA_IMAGE_RE: /!\[([^\]]*)\]\(media:([^)]+)\)/g,
    MEDIA_AUDIO_RE: /<audio\b[^>]*src="media:([^"]+)"[^>]*><\/audio>/gi,

    reset() {
        for (const [, pending] of this.requests) clearTimeout(pending.timer);
        this.requests.clear();
        this.cache.clear();
        this.watched.clear();
    },

    extractIds(template) {
        const ids = new Set();
        for (const match of template.matchAll(this.MEDIA_IMAGE_RE)) ids.add(match[2]);
        for (const match of template.matchAll(this.MEDIA_AUDIO_RE)) ids.add(match[1]);
        return [...ids];
    },

    // 后端模板 -> 可渲染内容；还没拉到的媒体先显示文字占位，不阻塞历史加载
    materialize(template) {
        return String(template)
            .replace(this.MEDIA_IMAGE_RE, (match, alt, id) => {
                const dataUrl = this.cache.get(id);
                return dataUrl ? `![${alt || '图片'}](${dataUrl})` : `[${alt || '图片'}]`;
            })
            .replace(this.MEDIA_AUDIO_RE, (match, id) => {
                const dataUrl = this.cache.get(id);
                return dataUrl ? `<audio controls src="${dataUrl}"></audio>` : '[语音]';
            });
    },

    renderInto(element, template) {
        const markdown = element?.querySelector('.markdown-content');
        if (!markdown) return;

        const content = this.materialize(template);
        try {
            markdown.innerHTML = MarkdownRenderer.render(content);
            MarkdownRenderer.processCodeBlocks(markdown);
            MarkdownRenderer.processPreviewBlocks(markdown);
            MarkdownRenderer.bindMathCopyEvents(markdown);
            MarkdownRenderer.renderMath(markdown);
        } catch (error) {
            console.error('[sf插件] Markdown 渲染失败:', error);
            markdown.textContent = content;
        }
    },

    // 把还缺媒体的消息登记下来，getMedia 回来后只刷新引用到该 id 的那几条
    watch(element, template, userQQ) {
        if (!element) return;
        const entry = { element, template };
        this.extractIds(template).forEach((id) => {
            if (this.cache.has(id)) return;
            if (!this.watched.has(id)) this.watched.set(id, new Set());
            this.watched.get(id).add(entry);
            this.request(id, userQQ);
        });
    },

    request(id, userQQ) {
        if (this.cache.has(id) || this.requests.has(id)) return;
        const ws = AppState.wsConnection;
        if (!ws || ws.readyState !== WebSocket.OPEN || !AppState.wsAuthenticated) return;

        const timer = setTimeout(() => this.resolve(id, null), this.REQUEST_TIMEOUT);
        this.requests.set(id, { timer });
        ws.send(JSON.stringify({ type: 'getMedia', userQQ, id }));
    },

    resolve(id, dataUrl) {
        const pending = this.requests.get(id);
        if (pending) {
            clearTimeout(pending.timer);
            this.requests.delete(id);
        }
        if (dataUrl) this.cache.set(id, dataUrl);

        const entries = this.watched.get(id);
        if (!entries) return;
        for (const entry of entries) this.renderInto(entry.element, entry.template);
        this.watched.delete(id);
    },
};

// ========== Markdown渲染器 ==========
const MarkdownRenderer = {
    // LaTeX占位符存储
    latexPlaceholders: [],
    placeholderPrefix: '%%LATEX_PLACEHOLDER_',
    
    init() {
        marked.setOptions({
            renderer: new marked.Renderer(),
            highlight: (code, lang) => {
                const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                return hljs.highlight(code, { language }).value;
            },
            langPrefix: 'hljs language-',
            pedantic: false,
            gfm: true,
            breaks: true,
            sanitize: false,
            smartypants: false,
            xhtml: false
        });
    },

    // 保护LaTeX公式，防止被Marked处理
    protectLatex(content) {
        this.latexPlaceholders = [];
        let result = content;
        
        // 保护代码块（先处理，避免代码块内的$被误识别）
        const codeBlocks = [];
        result = result.replace(/```[\s\S]*?```/g, (match) => {
            codeBlocks.push(match);
            return `%%CODE_BLOCK_${codeBlocks.length - 1}%%`;
        });
        result = result.replace(/`[^`]+`/g, (match) => {
            codeBlocks.push(match);
            return `%%CODE_BLOCK_${codeBlocks.length - 1}%%`;
        });
        
        // 保护块级公式 $$...$$ 和 \[...\]
        result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
            this.latexPlaceholders.push({ type: 'block', content: formula.trim() });
            return `${this.placeholderPrefix}${this.latexPlaceholders.length - 1}%%`;
        });
        result = result.replace(/\\\[([\s\S]*?)\\\]/g, (match, formula) => {
            this.latexPlaceholders.push({ type: 'block', content: formula.trim() });
            return `${this.placeholderPrefix}${this.latexPlaceholders.length - 1}%%`;
        });
        
        // 保护行内公式 $...$ 和 \(...\)
        // 注意：避免匹配货币符号（如 $100）
        result = result.replace(/\$([^\$\n]+?)\$/g, (match, formula) => {
            // 排除纯数字（货币）
            if (/^\d+([.,]\d+)?$/.test(formula.trim())) {
                return match;
            }
            this.latexPlaceholders.push({ type: 'inline', content: formula.trim() });
            return `${this.placeholderPrefix}${this.latexPlaceholders.length - 1}%%`;
        });
        result = result.replace(/\\\(([\s\S]*?)\\\)/g, (match, formula) => {
            this.latexPlaceholders.push({ type: 'inline', content: formula.trim() });
            return `${this.placeholderPrefix}${this.latexPlaceholders.length - 1}%%`;
        });
        
        // 恢复代码块
        result = result.replace(/%%CODE_BLOCK_(\d+)%%/g, (match, index) => {
            return codeBlocks[parseInt(index)];
        });
        
        return result;
    },

    // 恢复LaTeX公式
    restoreLatex(html) {
        let result = html;
        
        // 恢复所有LaTeX占位符
        result = result.replace(new RegExp(`${this.placeholderPrefix}(\\d+)%%`, 'g'), (match, index) => {
            const placeholder = this.latexPlaceholders[parseInt(index)];
            if (!placeholder) return match;
            
            // 转义HTML特殊字符用于data属性
            const escapedContent = placeholder.content
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            if (placeholder.type === 'block') {
                // 块级公式 - 添加data-latex属性存储源码
                return `<div class="math-block math-copyable" data-latex="${escapedContent}" title="点击复制公式">\\[${placeholder.content}\\]</div>`;
            } else {
                // 行内公式
                return `<span class="math-inline math-copyable" data-latex="${escapedContent}" title="点击复制公式">\\(${placeholder.content}\\)</span>`;
            }
        });
        
        return result;
    },

    // 为公式添加点击复制功能
    bindMathCopyEvents(container) {
        container.querySelectorAll('.math-copyable').forEach((el) => {
            // 避免重复绑定
            if (el.dataset.copyBound) return;
            el.dataset.copyBound = 'true';
            
            el.style.cursor = 'pointer';
            
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                
                const latex = el.dataset.latex || '';
                
                // 检测是否为复杂公式（包含环境、矩阵等）
                const isComplex = /\\begin|\\end|\\matrix|\\array|\\cases|\\align|\\eqnarray|\\gather/i.test(latex);
                
                let textToCopy;
                if (isComplex) {
                    // 复杂公式直接复制LaTeX源码（用$$包裹）
                    textToCopy = `$$${latex}$$`;
                } else {
                    // 简单公式转Unicode
                    textToCopy = this.latexToUnicode(latex);
                }
                
                if (!textToCopy) {
                    Utils.showToast('公式转换失败');
                    return;
                }
                
                const success = await Utils.copyToClipboard(textToCopy);
                if (success) {
                    const displayText = textToCopy.length > 35 ? textToCopy.slice(0, 35) + '...' : textToCopy;
                    Utils.showToast(`已复制: ${displayText}`);
                    el.classList.add('math-copied');
                    setTimeout(() => el.classList.remove('math-copied'), 600);
                } else {
                    Utils.showToast('复制失败');
                }
            });
        });
    },

    // LaTeX转Unicode数学符号（带格式）
    latexToUnicode(latex) {
        let result = latex;
        
        // 1. 先处理特殊结构（带空格格式）
        // 处理 \lim_{x \to a} 格式
        result = result.replace(/\\lim\s*_\s*{([^}]+)}/g, 'lim($1) ');
        result = result.replace(/\\lim\b/g, 'lim ');
        
        // 处理 \frac{a}{b} 格式
        result = result.replace(/\\frac\s*{([^}]+)}\s*{([^}]+)}/g, '($1)/($2)');
        
        // 处理 \sqrt{x} 和 \sqrt[n]{x}
        result = result.replace(/\\sqrt\s*\[([^\]]+)\]\s*{([^}]+)}/g, '($2)^(1/$1)');
        result = result.replace(/\\sqrt\s*{([^}]+)}/g, '√($1)');
        
        // 处理 \sum_{i=1}^{n} 格式
        result = result.replace(/\\sum\s*_\s*{([^}]+)}\s*\^\s*{([^}]+)}/g, '∑($1→$2) ');
        result = result.replace(/\\sum\b/g, '∑');
        
        // 处理 \int_{a}^{b} 格式
        result = result.replace(/\\int\s*_\s*{([^}]+)}\s*\^\s*{([^}]+)}/g, '∫($1→$2) ');
        result = result.replace(/\\int\b/g, '∫');
        
        // 处理 \prod_{i=1}^{n} 格式
        result = result.replace(/\\prod\s*_\s*{([^}]+)}\s*\^\s*{([^}]+)}/g, '∏($1→$2) ');
        result = result.replace(/\\prod\b/g, '∏');
        
        // 2. 替换希腊字母（加空格）
        const greekLetters = {
            '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
            '\\epsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ',
            '\\iota': 'ι', '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ',
            '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\rho': 'ρ',
            '\\sigma': 'σ', '\\tau': 'τ', '\\upsilon': 'υ', '\\phi': 'φ',
            '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
            '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
            '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Phi': 'Φ',
            '\\Psi': 'Ψ', '\\Omega': 'Ω',
        };
        
        // 3. 替换数学运算符
        const operators = {
            '\\times': ' × ', '\\div': ' ÷ ', '\\pm': ' ± ', '\\mp': ' ∓ ',
            '\\cdot': '·', '\\ast': ' ∗ ', '\\star': ' ⋆ ',
            '\\leq': ' ≤ ', '\\geq': ' ≥ ', '\\neq': ' ≠ ', '\\approx': ' ≈ ',
            '\\equiv': ' ≡ ', '\\sim': ' ∼ ', '\\simeq': ' ≃ ',
            '\\ll': ' ≪ ', '\\gg': ' ≫ ',
            '\\subset': ' ⊂ ', '\\supset': ' ⊃ ',
            '\\subseteq': ' ⊆ ', '\\supseteq': ' ⊇ ',
            '\\in': ' ∈ ', '\\notin': ' ∉ ',
            '\\cup': ' ∪ ', '\\cap': ' ∩ ', '\\setminus': ' ∖ ',
            '\\land': ' ∧ ', '\\lor': ' ∨ ', '\\neg': '¬',
            '\\forall': '∀', '\\exists': '∃', '\\nexists': '∄',
            '\\emptyset': '∅', '\\varnothing': '∅',
            '\\to': ' → ', '\\rightarrow': ' → ', '\\leftarrow': ' ← ',
            '\\leftrightarrow': ' ↔ ', '\\Rightarrow': ' ⇒ ', '\\Leftarrow': ' ⇐ ',
            '\\Leftrightarrow': ' ⇔ ', '\\mapsto': ' ↦ ',
            '\\uparrow': '↑', '\\downarrow': '↓',
            '\\partial': '∂', '\\nabla': '∇', '\\infty': '∞',
            '\\degree': '°', '\\circ': '°',
            '\\prime': '′', '\\dprime': '″',
            '\\angle': '∠', '\\triangle': '△',
            '\\perp': ' ⊥ ', '\\parallel': ' ∥ ',
            '\\therefore': ' ∴ ', '\\because': ' ∵ ',
            '\\dots': '...', '\\cdots': '···', '\\vdots': '⋮', '\\ddots': '⋱',
            '\\hbar': 'ℏ', '\\ell': 'ℓ',
            '\\Re': 'Re', '\\Im': 'Im',
            '\\aleph': 'ℵ',
            '\\langle': '⟨', '\\rangle': '⟩',
            '\\lceil': '⌈', '\\rceil': '⌉',
            '\\lfloor': '⌊', '\\rfloor': '⌋',
            '\\left': '', '\\right': '',
            '\\{': '{', '\\}': '}',
            '\\|': '‖', '\\,': ' ', '\\;': ' ', '\\quad': '  ', '\\qquad': '    ',
        };
        
        // 合并所有替换
        const allReplacements = { ...greekLetters, ...operators };
        
        for (const [cmd, unicode] of Object.entries(allReplacements)) {
            result = result.replace(new RegExp(cmd.replace(/\\/g, '\\\\'), 'g'), unicode);
        }
        
        // 4. 处理上标 ^{...} 或 ^x
        result = result.replace(/\^{([^}]+)}/g, (_, content) => this.toSuperscript(content));
        result = result.replace(/\^([0-9a-zA-Z+\-])/g, (_, char) => this.toSuperscript(char));
        
        // 5. 处理下标 _{...} 或 _x
        result = result.replace(/_{([^}]+)}/g, (_, content) => this.toSubscript(content));
        result = result.replace(/_([0-9a-zA-Z])/g, (_, char) => this.toSubscript(char));
        
        // 6. 清理剩余的LaTeX命令（保留文本）
        result = result.replace(/\\text{([^}]+)}/g, '$1');
        result = result.replace(/\\mathrm{([^}]+)}/g, '$1');
        result = result.replace(/\\mathbf{([^}]+)}/g, '$1');
        result = result.replace(/\\[a-zA-Z]+/g, ' ');
        
        // 7. 清理多余的括号和空格
        result = result.replace(/[{}]/g, '');
        result = result.replace(/\s+/g, ' ');
        result = result.trim();
        
        return result;
    },

    // 转换为上标
    toSuperscript(str) {
        const superscripts = {
            '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
            '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
            '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
            'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ', 'y': 'ʸ',
            'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ',
            'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'j': 'ʲ', 'k': 'ᵏ',
            'l': 'ˡ', 'm': 'ᵐ', 'o': 'ᵒ', 'p': 'ᵖ', 'r': 'ʳ',
            's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ', 'v': 'ᵛ', 'w': 'ʷ', 'z': 'ᶻ',
        };
        return str.split('').map(c => superscripts[c] || c).join('');
    },

    // 转换为下标
    toSubscript(str) {
        const subscripts = {
            '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
            '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
            '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
            'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
            'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ',
            'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
            'v': 'ᵥ', 'x': 'ₓ',
        };
        return str.split('').map(c => subscripts[c] || c).join('');
    },

    // 渲染Markdown内容
    render(content) {
        let processedContent = content;
        
        // 1. 保护LaTeX公式
        processedContent = this.protectLatex(processedContent);
        
        // 2. 处理图片链接
        if (processedContent.includes('![') && processedContent.includes('](data:image')) {
            processedContent = processedContent.replace(
                /!\[.*?\]\((data:image\/[^)]+)\)/g,
                '<img src="$1" class="chat-image">'
            );
        } else {
            processedContent = processedContent.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
                const separator = url.includes('?') ? '&' : '?';
                return `![${alt}](${url}${separator}t=${Date.now()})`;
            });
        }
        
        // 3. Marked渲染
        let html = marked.parse(processedContent);
        
        // 4. 恢复LaTeX公式
        html = this.restoreLatex(html);
        
        return html;
    },

    // 处理代码块
    processCodeBlocks(container) {
        container.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
            
            const language = block.className.replace(/^.*language-(\w+).*$/, '$1') || 'code';
            const pre = block.parentElement;
            
            // 创建代码头部
            const header = document.createElement('div');
            header.className = 'code-header';
            header.innerHTML = `
                <div class="code-header-left">
                    <div class="code-dots">
                        <span class="code-dot red"></span>
                        <span class="code-dot yellow"></span>
                        <span class="code-dot green"></span>
                    </div>
                    <span class="code-lang">${language !== 'hljs' ? language : 'code'}</span>
                </div>
                <button class="code-copy-btn" title="复制代码">
                    <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                    <span>复制</span>
                </button>
            `;
            
            pre.insertBefore(header, pre.firstChild);
            
            // 复制按钮事件
            const copyBtn = header.querySelector('.code-copy-btn');
            copyBtn.addEventListener('click', async () => {
                const success = await Utils.copyToClipboard(block.textContent);
                if (success) {
                    copyBtn.classList.add('copied');
                    copyBtn.querySelector('span').textContent = '已复制';
                    copyBtn.querySelector('svg').innerHTML = '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>';
                    setTimeout(() => {
                        copyBtn.classList.remove('copied');
                        copyBtn.querySelector('span').textContent = '复制';
                        copyBtn.querySelector('svg').innerHTML = '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>';
                    }, 2000);
                }
            });
        });
    },

    // 处理HTML/SVG预览
    processPreviewBlocks(container) {
        container.querySelectorAll('pre code.language-html, pre code.language-svg').forEach((block) => {
            const pre = block.parentElement;
            const code = block.textContent;
            const lang = block.className.includes('html') ? 'HTML' : 'SVG';
            
            // 创建预览容器
            const previewContainer = document.createElement('div');
            previewContainer.className = 'preview-container';
            previewContainer.innerHTML = `
                <div class="preview-header">
                    <span>${lang} 实时预览</span>
                    <button class="preview-toggle">切换代码/预览</button>
                </div>
                <div class="preview-content"></div>
            `;
            
            const previewContent = previewContainer.querySelector('.preview-content');
            const toggleBtn = previewContainer.querySelector('.preview-toggle');
            let showingPreview = true;
            
            // 渲染预览
            if (lang === 'SVG') {
                previewContent.innerHTML = code;
            } else {
                const iframe = document.createElement('iframe');
                iframe.sandbox = 'allow-scripts';
                previewContent.appendChild(iframe);
                iframe.contentDocument.open();
                iframe.contentDocument.write(code);
                iframe.contentDocument.close();
            }
            
            // 切换按钮
            toggleBtn.addEventListener('click', () => {
                showingPreview = !showingPreview;
                if (showingPreview) {
                    pre.style.display = 'none';
                    previewContent.style.display = 'block';
                    toggleBtn.textContent = '切换代码/预览';
                } else {
                    pre.style.display = 'block';
                    previewContent.style.display = 'none';
                    toggleBtn.textContent = '显示预览';
                }
            });
            
            pre.style.display = 'none';
            pre.parentNode.insertBefore(previewContainer, pre.nextSibling);
        });
    },

    // 渲染数学公式
    renderMath(container) {
        // 检查是否有数学公式需要渲染
        const hasMath = container.querySelector('.math-block, .math-inline') || 
                        container.textContent.includes('\\(') || 
                        container.textContent.includes('\\[');
        
        if (!hasMath) return;
        
        // 等待MathJax加载完成
        const tryRender = (retries = 0) => {
            if (window.MathJax && typeof MathJax.typesetPromise === 'function') {
                // 先清除之前的渲染（如果有）
                if (MathJax.typesetClear) {
                    MathJax.typesetClear([container]);
                }
                // 渲染新内容
                MathJax.typesetPromise([container])
                    .catch(err => {
                        console.error('MathJax渲染错误:', err);
                    });
            } else if (retries < 20) {
                // MathJax还没加载完，等待后重试（最多等待2秒）
                setTimeout(() => tryRender(retries + 1), 100);
            } else {
                console.warn('MathJax加载超时，公式可能无法正常显示');
            }
        };
        
        // 延迟一帧执行，确保DOM已更新
        requestAnimationFrame(() => tryRender());
    }
};


// ========== 消息管理 ==========
const MessageManager = {
    // 只滚动消息容器，避免 scrollIntoView 牵动移动端 visual viewport
    scrollMessageIntoView(element, block = 'center') {
        const container = DOM.messagesArea;
        if (!container || !element) return;

        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const relativeTop = elementRect.top - containerRect.top + container.scrollTop;
        const centerTop = relativeTop - ((container.clientHeight - elementRect.height) / 2);
        const endTop = relativeTop - container.clientHeight + elementRect.height + 16;
        const targetTop = block === 'end' ? endTop : centerTop;

        container.scrollTo({
            top: Math.max(0, targetTop),
            behavior: 'smooth'
        });
    },

    // 添加消息：内容完全来自调用方（实时消息或后端历史），本地不留副本
    addMessage(content, position) {
        if (!content || typeof content !== 'string') {
            console.error('Invalid message content:', content);
            return null;
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${position}`;
        
        const avatar = document.createElement('div');
        avatar.className = 'avatar';

        const userQQ = document.getElementById('user-qq')?.value.trim();
        const botQQ = document.getElementById('bot-qq')?.value.trim();

        if (position === 'right' && userQQ) {
            avatar.style.backgroundImage = `url(https://q1.qlogo.cn/g?b=qq&s=0&nk=${userQQ})`;
        } else if (position === 'left' && botQQ) {
            avatar.style.backgroundImage = `url(https://q1.qlogo.cn/g?b=qq&s=0&nk=${botQQ})`;
        } else {
            avatar.style.backgroundImage = position === 'left' ? 
                'url("images/bot-avatar.png")' : 
                'url("images/user-avatar.png")';
        }
        
        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        
        const markdownContent = document.createElement('div');
        markdownContent.className = 'markdown-content';
        
        messageContent.appendChild(markdownContent);
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(messageContent);
        DOM.messagesArea.appendChild(messageDiv);

        // 实时消息里的 data URL 原样渲染；历史里的 media:<id> 会在
        // getMedia 返回后由 ServerMedia.renderInto 原地刷新
        ServerMedia.renderInto(messageDiv, content);

        // 滚动处理
        if (position === 'right') {
            AppState.lastUserMessageElement = messageDiv;
            setTimeout(() => this.scrollMessageIntoView(messageDiv), 100);
        } else if (position === 'left' && AppState.lastUserMessageElement) {
            setTimeout(() => this.scrollMessageIntoView(AppState.lastUserMessageElement), 100);
        }
        
        return messageDiv;
    },

    // 显示等待指示器
    showTypingIndicator() {
        this.removeTypingIndicator();
        
        const typingDiv = document.createElement('div');
        typingDiv.className = 'typing-indicator';
        typingDiv.id = 'typing-indicator';
        
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        
        const botQQ = document.getElementById('bot-qq')?.value.trim();
        avatar.style.backgroundImage = botQQ 
            ? `url(https://q1.qlogo.cn/g?b=qq&s=0&nk=${botQQ})`
            : 'url("images/bot-avatar.png")';
        
        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        
        const typingAnimation = document.createElement('div');
        typingAnimation.className = 'typing-animation';
        
        for (let i = 0; i < 3; i++) {
            const circle = document.createElement('div');
            circle.className = 'typing-circle';
            typingAnimation.appendChild(circle);
        }
        
        messageContent.appendChild(typingAnimation);
        typingDiv.appendChild(avatar);
        typingDiv.appendChild(messageContent);
        DOM.messagesArea.appendChild(typingDiv);
        
        setTimeout(() => this.scrollMessageIntoView(typingDiv, 'end'), 100);
    },

    // 移除等待指示器
    removeTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    },

    // 清空消息
    clearMessages() {
        DOM.messagesArea.innerHTML = '';
    }
};

// ========== WebSocket管理 ==========
const WebSocketManager = {
    // 连接WebSocket
    connect(ip, port, isAutoConnect = false) {
        if (!ip) {
            if (!isAutoConnect) Utils.showToast('请输入服务器地址');
            return;
        }
        
        try {
            if (AppState.wsConnection) {
                // 旧连接关闭时不能再改当前连接的状态：以前它的 onclose 会把
                // wsAuthenticated 置 false，导致新连接的 requestHistory 被跳过
                const previous = AppState.wsConnection;
                previous.onopen = null;
                previous.onclose = null;
                previous.onerror = null;
                previous.onmessage = null;
                previous.close();
            }
            
            const serverAddress = port ? `${ip}:${port}` : `${ip}:8081`;
            const directUrl = `ws://${serverAddress}`;
            const wsUrl = window.location.protocol === 'https:' && WS_DIRECT_URL
                ? WS_DIRECT_URL
                : directUrl;

            const ws = new WebSocket(wsUrl);
            AppState.wsConnection = ws;
            const isCurrent = () => AppState.wsConnection === ws;
            
            const connectionTimeout = setTimeout(() => {
                if (!isCurrent()) return;
                if (!AppState.wsConnected) {
                    ws.close();
                    if (!isAutoConnect) Utils.showToast('连接超时，请检查IP和端口是否正确');
                    this.updateStatus('未连接', '#f44336');
                }
            }, 5000);
            
            ws.onopen = () => {
                if (!isCurrent()) return;
                clearTimeout(connectionTimeout);
                AppState.wsConnected = true;
                AppState.wsAuthenticated = false;
                this.updateStatus('认证中', '#ff9800');
                
                this.startAutoReconnect();
                
                const password = document.getElementById('ws-password')?.value.trim();
                ws.send(JSON.stringify({ type: 'auth', password }));
            };
            
            ws.onclose = () => {
                if (!isCurrent()) return;
                AppState.wsConnected = false;
                AppState.wsAuthenticated = false;
                this.updateStatus('未连接', '#f44336');
                if (!isAutoConnect) Utils.showToast('连接已断开');
            };
            
            ws.onerror = (error) => {
                if (!isCurrent()) return;
                console.error('[sf插件] WebSocket错误:', error);
                if (!isAutoConnect) Utils.showToast('连接失败，请确保服务器已启动');
                this.updateStatus('未连接', '#f44336');
                AppState.wsAuthenticated = false;
                MessageManager.removeTypingIndicator();
            };
            
            ws.onmessage = (event) => this.handleMessage(event);
            
        } catch (error) {
            if (!isAutoConnect) Utils.showToast('连接失败: ' + error.message);
            this.updateStatus('未连接', '#f44336');
            MessageManager.removeTypingIndicator();
        }
    },

    // 请求服务端历史记录：只认当前 socket 的真实状态，不受全局标志竞态影响
    requestHistory() {
        const ws = AppState.wsConnection;
        if (!ws || ws.readyState !== WebSocket.OPEN || !AppState.wsAuthenticated) return;

        const userQQ = document.getElementById('user-qq')?.value.trim() || 'web_user';
        ws.send(JSON.stringify({
            type: 'loadHistory',
            userQQ: userQQ
        }));
    },

    // 处理消息
    handleMessage(event) {
        // 已被新连接顶替的 socket 迟到的消息一律丢弃
        if (event.target && event.target !== AppState.wsConnection) return;
        try {
            const msgObj = JSON.parse(event.data);
            
            if (msgObj.type === 'auth') {
                AppState.wsAuthenticated = msgObj.success;
                if (msgObj.success) {
                    this.updateStatus('已连接', '#4CAF50');
                    Utils.showToast('连接成功！');
                    DOM.settingsModal.classList.remove('active');
                    DOM.modalOverlay.classList.remove('active');
                    SettingsManager.save();
                    this.requestHistory();
                } else {
                    const message = msgObj.message || '认证失败';
                    this.updateStatus(message, '#f44336');
                    Utils.showToast(message);
                }
                return;
            }
            
            if (msgObj.type === 'error') {
                console.error('[sf插件] 服务器错误:', msgObj.content);
                Utils.showToast('服务器错误: ' + msgObj.content);
                MessageManager.removeTypingIndicator();
            } else if (msgObj.type === 'history') {
                // 后端是唯一数据源：先把文本全部渲染出来，媒体异步补齐。
                // 不再等任何预取，某张图取不到也不会让整页空白。
                MessageManager.clearMessages();
                ServerMedia.reset();
                MessageManager.removeTypingIndicator();
                const historyUserQQ = document.getElementById('user-qq')?.value.trim() || 'web_user';
                const messages = Array.isArray(msgObj.messages) ? msgObj.messages : [];
                for (const msg of messages) {
                    if (!msg || typeof msg.content !== 'string') continue;
                    const element = MessageManager.addMessage(
                        msg.content,
                        msg.role === 'user' ? 'right' : 'left'
                    );
                    ServerMedia.watch(element, msg.content, historyUserQQ);
                }
            } else if (msgObj.type === 'media') {
                ServerMedia.resolve(msgObj.id, msgObj.dataUrl);
            } else if (msgObj.type === 'mediaMissing') {
                ServerMedia.resolve(msgObj.id, null);
            } else if (msgObj.type === 'historyCleared') {
                ServerMedia.reset();
                MessageManager.clearMessages();
                Utils.showToast('对话记录已清空');
            } else if (msgObj.type === 'typing') {
                if (msgObj.active) {
                    MessageManager.showTypingIndicator();
                } else {
                    MessageManager.removeTypingIndicator();
                }
            } else if (typeof msgObj.content === 'string' && msgObj.content.trim()) {
                MessageManager.removeTypingIndicator();
                MessageManager.addMessage(msgObj.content.trim(), 'left');
            }
        } catch (error) {
            console.error('[sf插件] 处理消息错误:', error);
            Utils.showToast('处理消息时出错');
            MessageManager.removeTypingIndicator();
        }
    },

    // 发送消息
    send(message, images = []) {
        const ws = AppState.wsConnection;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            Utils.showToast('请先连接WebSocket服务器');
            return false;
        }

        if (!AppState.wsAuthenticated) {
            Utils.showToast('请先完成访问认证');
            return false;
        }
        
        const msgObj = {
            type: 'message',
            content: message,
            timestamp: Date.now(),
            images: images.length > 0 ? images : undefined,
            userQQ: document.getElementById('user-qq')?.value.trim() || 'web_user'
        };
        
        AppState.wsConnection.send(JSON.stringify(msgObj));
        return true;
    },

    // 更新状态显示
    updateStatus(text, color) {
        const statusEl = document.getElementById('ws-status');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }
    },

    // 自动重连
    startAutoReconnect() {
        if (AppState.autoReconnectTimer) {
            clearInterval(AppState.autoReconnectTimer);
        }
        AppState.autoReconnectTimer = setInterval(() => {
            if (!AppState.wsConnected) {
                const ip = document.getElementById('ws-ip')?.value.trim();
                const port = document.getElementById('ws-port')?.value.trim();
                if (ip) this.connect(ip, port, true);
            }
        }, AppState.RECONNECT_INTERVAL);
    }
};


// ========== 设置管理 ==========
const SettingsManager = {
    // 保存设置
    save() {
        const settings = {
            ip: document.getElementById('ws-ip')?.value.trim() || '',
            port: document.getElementById('ws-port')?.value.trim() || '',
            userQQ: document.getElementById('user-qq')?.value.trim() || '',
            botQQ: document.getElementById('bot-qq')?.value.trim() || '',
            wsPassword: document.getElementById('ws-password')?.value.trim() || '',
            showAvatar: document.getElementById('avatar-toggle')?.checked ?? true,
            lastUpdate: Date.now()
        };
        localStorage.setItem('sf_plugin_settings', JSON.stringify(settings));
        
        // 更新头像显示状态
        DOM.chatContainer?.classList.toggle('no-avatar', !settings.showAvatar);
    },

    // 加载设置
    load() {
        try {
            const settings = JSON.parse(localStorage.getItem('sf_plugin_settings'));
            if (!settings) return;
            
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = val || '';
            };
            
            setVal('ws-ip', settings.ip);
            setVal('ws-port', settings.port);
            setVal('user-qq', settings.userQQ);
            setVal('bot-qq', settings.botQQ);
            setVal('ws-password', settings.wsPassword);
            
            const avatarToggle = document.getElementById('avatar-toggle');
            if (avatarToggle) {
                avatarToggle.checked = settings.showAvatar !== false;
                DOM.chatContainer?.classList.toggle('no-avatar', !settings.showAvatar);
            }
            
            // 自动连接
            if (settings.ip) {
                setTimeout(() => WebSocketManager.connect(settings.ip, settings.port, true), 1000);
            }
        } catch (error) {
            console.error('加载设置失败:', error);
        }
    }
};

// ========== 图片管理 ==========
const ImageManager = {
    // 添加图片预览
    addPreview(base64Data, fileName) {
        const previewItem = document.createElement('div');
        previewItem.className = 'image-preview-item';
        previewItem.dataset.base64 = base64Data;
        
        const img = document.createElement('img');
        img.src = base64Data;
        
        const removeButton = document.createElement('button');
        removeButton.className = 'remove-image';
        removeButton.innerHTML = '×';
        removeButton.onclick = () => previewItem.remove();
        
        previewItem.appendChild(img);
        previewItem.appendChild(removeButton);
        DOM.imagePreviewContainer?.appendChild(previewItem);
    },

    // 获取所有预览图片
    getAllImages() {
        const images = [];
        const items = DOM.imagePreviewContainer?.getElementsByClassName('image-preview-item') || [];
        for (const item of items) {
            images.push(item.dataset.base64);
        }
        return images;
    },

    // 清空预览
    clearPreviews() {
        if (DOM.imagePreviewContainer) {
            DOM.imagePreviewContainer.innerHTML = '';
        }
    },

    // 上传图片
    upload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.onchange = (e) => {
            Array.from(e.target.files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (e) => this.addPreview(e.target.result, file.name);
                reader.readAsDataURL(file);
            });
        };
        input.click();
    }
};

// ========== 图片预览 ==========
const ImagePreview = {
    modal: null,
    overlay: null,
    img: null,
    closeBtn: null,
    info: null,

    init() {
        this.modal = document.getElementById('image-modal');
        this.overlay = document.getElementById('image-modal-overlay');
        this.img = document.getElementById('image-modal-img');
        this.closeBtn = document.getElementById('image-modal-close');
        this.info = document.getElementById('image-modal-info');

        if (!this.modal) return;

        this.closeBtn?.addEventListener('click', () => this.close());
        this.overlay?.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });
    },

    open(src) {
        if (!this.modal || !src) return;
        this.img.src = src;

        const sizeText = src.startsWith('data:') ? `(${this.formatSize(src.length)})` : '';
        this.info.textContent = `原图 ${sizeText}`;

        this.modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    },

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('active');
        document.body.style.overflow = '';
        setTimeout(() => { this.img.src = ''; }, 300);
    },

    formatSize(bytes) {
        const kb = Math.round(bytes / 1024);
        if (kb < 1024) return `${kb} KB`;
        return `${(kb / 1024).toFixed(1)} MB`;
    }
};

// ========== 事件绑定 ==========
const EventBinder = {
    init() {
        // 发送消息
        DOM.sendButton?.addEventListener('click', () => this.handleSend());

        // 图片点击预览（事件委托）
        DOM.messagesArea?.addEventListener('click', (e) => {
            const img = e.target.closest('.chat-image, .markdown-content img');
            if (img) ImagePreview.open(img.src);
        });
        
        // 输入框事件
        DOM.messageInput?.addEventListener('input', function() {
            Utils.autoResizeInput(this);
        });
        
        DOM.messageInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });
        
        
        // 设置按钮
        DOM.settingsButton?.addEventListener('click', () => {
            DOM.settingsModal?.classList.add('active');
            DOM.modalOverlay?.classList.add('active');
        });
        
        // 关闭设置
        document.getElementById('close-settings')?.addEventListener('click', () => {
            DOM.settingsModal?.classList.remove('active');
            DOM.modalOverlay?.classList.remove('active');
        });
        
        DOM.modalOverlay?.addEventListener('click', () => {
            DOM.settingsModal?.classList.remove('active');
            DOM.modalOverlay?.classList.remove('active');
        });
        
        // Close settings when clicking outside the panel
        DOM.settingsModal?.addEventListener('click', (e) => {
            if (e.target === DOM.settingsModal) {
                DOM.settingsModal.classList.remove('active');
                DOM.modalOverlay?.classList.remove('active');
            }
        });
        
        // 连接按钮
        document.getElementById('ws-connect')?.addEventListener('click', () => {
            const ip = document.getElementById('ws-ip')?.value.trim();
            const port = document.getElementById('ws-port')?.value.trim();
            SettingsManager.save();
            WebSocketManager.connect(ip, port);
        });
        
        // 工具按钮
        document.getElementById('upload-button')?.addEventListener('click', () => ImageManager.upload());
        
        document.getElementById('clear-button')?.addEventListener('click', async () => {
            if (!await Utils.showConfirm('只清空当前页面显示？服务端对话记录会保留，重新连接即可恢复。')) return;
            ServerMedia.reset();
            MessageManager.clearMessages();
            Utils.showToast('页面已清空，重新连接可恢复历史');
        });

        document.getElementById('clear-history-button')?.addEventListener('click', async () => {
            if (!await Utils.showConfirm('确定要清空服务端的对话记录吗？此操作不可撤销。')) return;
            const ws = AppState.wsConnection;
            if (!ws || ws.readyState !== WebSocket.OPEN || !AppState.wsAuthenticated) {
                Utils.showToast('请先连接服务器');
                return;
            }
            const userQQ = document.getElementById('user-qq')?.value.trim() || 'web_user';
            ws.send(JSON.stringify({ type: 'clearHistory', userQQ }));
            Utils.showToast('正在清空对话记录...');
        });
        
        // 头像开关
        document.getElementById('avatar-toggle')?.addEventListener('change', () => SettingsManager.save());
        
        // 设置输入变化自动保存
        ['ws-ip', 'ws-port', 'user-qq', 'bot-qq', 'ws-password'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => SettingsManager.save());
        });
        
        // 菜单切换
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                item.classList.add('active');
                document.getElementById(`${item.dataset.tab}-tab`)?.classList.add('active');
            });
        });
        
        // 移动端适配 — 只同步 app shell 高度，输入区保持正常 flex 流
        this.initMobileSupport();
    },

    // 处理发送
    handleSend() {
        const message = DOM.messageInput?.value.trim() || '';
        const images = ImageManager.getAllImages();
        
        if (!message && images.length === 0) return;
        
        // 构建显示内容
        let displayContent = message;
        if (images.length > 0) {
            images.forEach((base64, index) => {
                displayContent += `\n![图片${index + 1}](${base64})`;
            });
        }
        
        // 本地只做即时显示，持久化完全交给后端
        MessageManager.addMessage(displayContent, 'right');
        
        // 发送到服务器
        if (WebSocketManager.send(message, images)) {
            DOM.messageInput.value = '';
            Utils.autoResizeInput(DOM.messageInput);
            ImageManager.clearPreviews();
            MessageManager.showTypingIndicator();
        }
    },

    // 移动端支持 — 只跟随浏览器给出的真实可见高度，不猜测键盘高度
    // visualViewport.height 本身就是「用户现在能看到的区域」，键盘弹起时浏览器
    // 会把它扣掉，收起时自动还原。所以直接同步即可，不需要 focus 状态、基准高度
    // 或任何按比例估算 —— 那些猜测正是收起键盘后留下半屏空白的原因。
    initMobileSupport() {
        // 键盘处理和屏幕宽度无关：横屏手机、平板同样需要，按「是不是触摸设备」判断
        const isHandheldLayout = () =>
            window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
        const root = document.documentElement;
        const body = document.body;
        const input = DOM.messageInput;
        let pendingFrame = 0;

        const reset = () => {
            root.style.removeProperty('--app-height');
            body.style.removeProperty('padding-top');
        };

        const update = () => {
            pendingFrame = 0;
            if (!isHandheldLayout()) {
                reset();
                return;
            }

            const vv = window.visualViewport;
            if (!vv) {
                root.style.setProperty('--app-height', Math.round(window.innerHeight) + 'px');
                body.style.removeProperty('padding-top');
                return;
            }

            // 捏合缩放同样会让 visualViewport 变小，那不是键盘，保持缩放前的值
            const scale = vv.scale || 1;
            if (Math.abs(scale - 1) > 0.01 || Math.abs(vv.width - window.innerWidth) > 1) return;

            const visibleHeight = Math.round(vv.height || 0);
            if (!visibleHeight) {
                reset();
                return;
            }

            // iOS 不认 resizes-content：键盘弹起时视觉视口可能整体下移 offsetTop，
            // 只把高度设成 visibleHeight 会让顶部被裁、底部留白。可见区域的底边是
            // offsetTop + visibleHeight，用它当整页高度，再用 padding-top 把内容推下去。
            const layoutHeight = Math.round(window.innerHeight || visibleHeight);
            const offsetTop = Math.max(0, Math.round(vv.offsetTop || 0));
            const appHeight = Math.min(offsetTop + visibleHeight, layoutHeight);
            const paddingTop = Math.max(0, appHeight - visibleHeight);

            root.style.setProperty('--app-height', appHeight + 'px');
            if (paddingTop > 0) {
                body.style.paddingTop = paddingTop + 'px';
            } else {
                body.style.removeProperty('padding-top');
            }
        };

        const scheduleUpdate = () => {
            if (pendingFrame) return;
            pendingFrame = requestAnimationFrame(update);
        };

        // 键盘动画、浏览器工具栏收起都会晚于事件本身，补几次采样即可收敛
        const nudge = () => {
            [0, 80, 250, 500].forEach(delay => setTimeout(scheduleUpdate, delay));
        };

        const viewport = window.visualViewport;
        if (viewport) {
            viewport.addEventListener('resize', scheduleUpdate);
            viewport.addEventListener('scroll', scheduleUpdate);
        }
        window.addEventListener('resize', scheduleUpdate);
        window.addEventListener('orientationchange', nudge);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) scheduleUpdate();
        });
        input?.addEventListener('focus', nudge);
        input?.addEventListener('blur', nudge);

        scheduleUpdate();
    },
};

// ========== 应用初始化 ==========
const App = {
    init() {
        DOM.init();
        MarkdownRenderer.init();
        EventBinder.init();
        ImagePreview.init();
        SettingsManager.load();
        this.registerServiceWorker();
        this.renderVersionInfo();
    },

    // 关于页的版本信息：用来确认浏览器到底跑到哪一版
    async renderVersionInfo() {
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        set('app-version', APP_VERSION);
        set('app-build', APP_BUILD);
        console.info(`[SFChat] 前端 ${APP_VERSION}（${APP_BUILD}）`);

        if (!('caches' in window)) {
            set('app-cache', '浏览器不支持');
            return;
        }

        try {
            const names = await caches.keys();
            const own = names.filter(name => name.startsWith('sfchat-')).sort();
            set('app-cache', own.length ? own.join(' / ') : '无');
        } catch (error) {
            set('app-cache', '读取失败');
        }
    },

    registerServiceWorker() {
        // 只在 http/https 协议下注册 ServiceWorker（本地 file:// 不支持）
        if ('serviceWorker' in navigator && location.protocol !== 'file:') {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
                    .catch(err => console.warn('ServiceWorker 注册失败:', err));
            });
        }
    }
};

// 启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
