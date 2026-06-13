/**
 * SFChat - 云崽对话界面
 * 主应用模块
 */

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

// ========== 媒体缓存管理 ==========
const MediaCache = {
    DB_NAME: 'sf_chat_media_cache',
    DB_VERSION: 1,
    MEDIA_STORE: 'media',
    MESSAGE_STORE: 'messages',
    CLEAR_HISTORY_COMMAND: '#web清空记录',
    dbPromise: null,
    disabled: false,
    restoreBatchUsedIds: null,

    openDb() {
        if (this.disabled || !window.indexedDB) return Promise.resolve(null);
        if (this.dbPromise) return this.dbPromise;

        this.dbPromise = new Promise((resolve) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains(this.MEDIA_STORE)) {
                    const mediaStore = db.createObjectStore(this.MEDIA_STORE, { keyPath: 'id' });
                    mediaStore.createIndex('byScope', 'scope', { unique: false });
                }

                if (!db.objectStoreNames.contains(this.MESSAGE_STORE)) {
                    const messageStore = db.createObjectStore(this.MESSAGE_STORE, { keyPath: 'id' });
                    messageStore.createIndex('byScope', 'scope', { unique: false });
                    messageStore.createIndex('byLookupKey', 'lookupKey', { unique: false });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                console.warn('媒体缓存不可用:', request.error);
                this.disabled = true;
                this.dbPromise = null;
                resolve(null);
            };
        });

        return this.dbPromise;
    },

    requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    },

    getScope() {
        const ip = this.normalizeScopePart(document.getElementById('ws-ip')?.value, 'default_host');
        const port = this.normalizeScopePart(document.getElementById('ws-port')?.value, '8081');
        const userQQ = this.normalizeScopePart(document.getElementById('user-qq')?.value, 'web_user');
        return `${ip}:${port}:${userQQ}`;
    },

    normalizeScopePart(value, fallback) {
        const text = typeof value === 'string' ? value.trim() : '';
        return (text || fallback).replace(/[^\w.-]/g, '_').slice(0, 96);
    },

    getRole(position) {
        return position === 'right' ? 'user' : 'bot';
    },

    hashString(value) {
        const text = String(value);
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
    },

    buildLookupKey(scope, role, normalizedContent) {
        return `${scope}|${role}|${this.hashString(this.canonicalizeLookupContent(normalizedContent))}`;
    },

    buildOutgoingHistoryContent(content, imageCount = 0) {
        const parts = [];
        const text = typeof content === 'string' ? content.trim() : '';
        if (text) parts.push(text);
        for (let i = 0; i < imageCount; i++) parts.push('[图片]');
        return parts.join(' ') || '[图片]';
    },

    canonicalizeLookupContent(content) {
        const text = String(content || '')
            .replace(/【\s*(图片|语音)\s*】/g, '[$1]')
            .replace(/\[\s*(图片|语音)\s*\]/g, '[$1]')
            .replace(/\s+/g, ' ')
            .replace(/\s*(\[(?:图片|语音)\])\s*/g, ' $1 ')
            .replace(/\s+/g, ' ')
            .trim();
        return text || '[消息]';
    },

    getPlaceholderTypes(content) {
        return [...String(content || '').matchAll(/\[(图片|语音)\]/g)]
            .map(([, label]) => label === '语音' ? 'audio' : 'image');
    },

    getMediaSignatureFromTypes(types) {
        return Array.isArray(types) ? types.join('|') : '';
    },

    getMediaSignatureFromRefs(mediaRefs) {
        return this.getMediaSignatureFromTypes((mediaRefs || []).map(ref => ref.type));
    },

    getTextFingerprint(content) {
        return this.canonicalizeLookupContent(content)
            .replace(/\[(?:图片|语音)\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    isSameMediaSequence(mediaRefs, placeholderTypes) {
        if (!Array.isArray(mediaRefs) || mediaRefs.length !== placeholderTypes.length) return false;
        return mediaRefs.every((ref, index) => ref.type === placeholderTypes[index]);
    },

    isCompatibleHistoryEntry(record, historyEntry) {
        if (!record?.mediaRefs?.length || record.role !== historyEntry.role) return false;
        if (!this.isSameMediaSequence(record.mediaRefs, historyEntry.placeholderTypes)) return false;

        const recordText = this.getTextFingerprint(record.normalizedContent);
        return recordText === historyEntry.textFingerprint || !recordText || !historyEntry.textFingerprint;
    },

    shouldRetainCachedMessage(record, historyEntries) {
        if (historyEntries.some(entry => entry.lookupKey === record.lookupKey)) return true;
        return historyEntries.some(entry => this.isCompatibleHistoryEntry(record, entry));
    },

    extractSrc(html) {
        const match = String(html).match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
        return match ? (match[1] || match[2] || match[3] || '') : '';
    },

    parseDataUrl(dataUrl) {
        const match = String(dataUrl).match(/^data:([^;,]+)[^,]*,/i);
        if (!match) return null;
        const mime = match[1].toLowerCase();
        const type = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : '';
        if (!type) return null;
        return { mime, type };
    },

    normalizeMessageContent(content) {
        const raw = String(content || '');
        const mediaItems = [];
        let hasImage = false;
        let hasAudio = false;

        let normalized = raw.replace(/<audio\b[\s\S]*?<\/audio>|<audio\b[^>]*>|<img\b[^>]*>|!\[([^\]]*)\]\(([^)]+)\)/gi, (match, alt, markdownUrl) => {
            if (match.startsWith('![')) {
                hasImage = true;
                const media = this.parseDataUrl(markdownUrl);
                if (media?.type === 'image') {
                    mediaItems.push({ type: 'image', mime: media.mime, dataUrl: markdownUrl, alt: alt || '图片' });
                }
                return ' [图片] ';
            }

            if (/^<audio\b/i.test(match)) {
                hasAudio = true;
                const src = this.extractSrc(match);
                const media = this.parseDataUrl(src);
                if (media?.type === 'audio') {
                    mediaItems.push({ type: 'audio', mime: media.mime, dataUrl: src });
                }
                return ' [语音] ';
            }

            hasImage = true;
            const src = this.extractSrc(match);
            const media = this.parseDataUrl(src);
            if (media?.type === 'image') {
                mediaItems.push({ type: 'image', mime: media.mime, dataUrl: src, alt: '图片' });
            }
            return ' [图片] ';
        });

        normalized = normalized
            .replace(/<[^>]+>/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/[ \t]*\n[ \t]*/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        if (!normalized) {
            if (hasImage) normalized = '[图片]';
            else if (hasAudio) normalized = '[语音]';
            else normalized = '[消息]';
        }

        return { normalizedContent: normalized, mediaItems };
    },

    async putRecords(mediaRecords, messageRecord) {
        const db = await this.openDb();
        if (!db) return;

        const transaction = db.transaction([this.MEDIA_STORE, this.MESSAGE_STORE], 'readwrite');
        const mediaStore = transaction.objectStore(this.MEDIA_STORE);
        const messageStore = transaction.objectStore(this.MESSAGE_STORE);

        mediaRecords.forEach(record => mediaStore.put(record));
        messageStore.put(messageRecord);

        await this.transactionDone(transaction);
    },

    async cacheMessageMedia(content, role, options = {}) {
        try {
            const extracted = this.normalizeMessageContent(content);
            if (extracted.mediaItems.length === 0) return;

            const scope = this.getScope();
            const now = Date.now();
            const normalizedContent = this.normalizeMessageContent(options.historyContent || extracted.normalizedContent).normalizedContent;
            const lookupKey = this.buildLookupKey(scope, role, normalizedContent);
            const mediaRecords = [];
            const mediaRefs = extracted.mediaItems.map((item, index) => {
                const mediaId = `${scope}|${item.type}|${this.hashString(item.dataUrl)}`;
                mediaRecords.push({
                    id: mediaId,
                    scope,
                    type: item.type,
                    mime: item.mime,
                    dataUrl: item.dataUrl,
                    size: item.dataUrl.length,
                    createdAt: now,
                    lastUsedAt: now
                });
                return {
                    type: item.type,
                    mediaId,
                    alt: item.alt || (item.type === 'image' ? `图片${index + 1}` : '语音')
                };
            });

            const messageRecord = {
                id: `${lookupKey}|${now}|${Math.random().toString(36).slice(2, 8)}`,
                scope,
                role,
                normalizedContent,
                lookupKey,
                lookupContent: this.canonicalizeLookupContent(normalizedContent),
                mediaSignature: this.getMediaSignatureFromRefs(mediaRefs),
                mediaRefs,
                createdAt: now,
                lastUsedAt: now
            };

            await this.putRecords(mediaRecords, messageRecord);
        } catch (error) {
            console.warn('缓存媒体失败:', error);
        }
    },

    beginRestoreBatch() {
        this.restoreBatchUsedIds = new Set();
    },

    endRestoreBatch() {
        this.restoreBatchUsedIds = null;
    },

    async getAllByIndex(storeName, indexName, key) {
        const db = await this.openDb();
        if (!db) return [];

        const transaction = db.transaction(storeName, 'readonly');
        const index = transaction.objectStore(storeName).index(indexName);
        const records = await this.requestToPromise(index.getAll(key));
        await this.transactionDone(transaction);
        return records || [];
    },

    async getMediaRecords(mediaIds) {
        const db = await this.openDb();
        if (!db) return new Map();

        const transaction = db.transaction(this.MEDIA_STORE, 'readonly');
        const store = transaction.objectStore(this.MEDIA_STORE);
        const pairs = await Promise.all(mediaIds.map(async id => [id, await this.requestToPromise(store.get(id))]));
        await this.transactionDone(transaction);
        return new Map(pairs.filter(([, record]) => record));
    },

    buildMediaMarkup(ref, mediaRecord) {
        if (!mediaRecord?.dataUrl) return null;
        if (ref.type === 'audio') {
            return `<audio controls src="${this.escapeHtmlAttribute(mediaRecord.dataUrl)}"></audio>`;
        }
        return `![${ref.alt || '图片'}](${mediaRecord.dataUrl})`;
    },

    escapeHtmlAttribute(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    injectMedia(normalizedContent, mediaRefs, mediaRecords) {
        let cursor = 0;
        return normalizedContent.replace(/\[(图片|语音)\]/g, (placeholder, label) => {
            const expectedType = label === '语音' ? 'audio' : 'image';
            while (cursor < mediaRefs.length) {
                const ref = mediaRefs[cursor++];
                if (ref.type !== expectedType) continue;

                const markup = this.buildMediaMarkup(ref, mediaRecords.get(ref.mediaId));
                return markup || placeholder;
            }
            return placeholder;
        });
    },

    pickRestoreCandidate(records, normalizedContent, role, allowCompatible = false) {
        const usedIds = this.restoreBatchUsedIds;
        const placeholderTypes = this.getPlaceholderTypes(normalizedContent);
        const historyEntry = {
            role,
            placeholderTypes,
            textFingerprint: this.getTextFingerprint(normalizedContent)
        };

        return (records || [])
            .filter(record => record?.role === role && record.mediaRefs?.length)
            .filter(record => !usedIds || !usedIds.has(record.id))
            .filter(record => !allowCompatible || this.isCompatibleHistoryEntry(record, historyEntry))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    },

    async restoreMessageMedia(content, role) {
        try {
            const { normalizedContent } = this.normalizeMessageContent(content);
            const scope = this.getScope();
            const lookupKey = this.buildLookupKey(scope, role, normalizedContent);
            const candidates = await this.getAllByIndex(this.MESSAGE_STORE, 'byLookupKey', lookupKey);
            let messageRecord = this.pickRestoreCandidate(candidates, normalizedContent, role);

            if (!messageRecord) {
                const scopedCandidates = await this.getAllByIndex(this.MESSAGE_STORE, 'byScope', scope);
                messageRecord = this.pickRestoreCandidate(scopedCandidates, normalizedContent, role, true);
            }

            if (!messageRecord?.mediaRefs?.length) return content;
            const usedIds = this.restoreBatchUsedIds;
            if (usedIds) usedIds.add(messageRecord.id);

            const mediaRecords = await this.getMediaRecords(messageRecord.mediaRefs.map(ref => ref.mediaId));
            if (mediaRecords.size === 0) return content;
            return this.injectMedia(normalizedContent, messageRecord.mediaRefs, mediaRecords);
        } catch (error) {
            console.warn('恢复媒体缓存失败:', error);
            return content;
        }
    },

    async deleteRecords(storeName, ids) {
        if (ids.length === 0) return;
        const db = await this.openDb();
        if (!db) return;

        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        ids.forEach(id => store.delete(id));
        await this.transactionDone(transaction);
    },

    async clearCurrentScope() {
        try {
            const scope = this.getScope();
            const [messages, media] = await Promise.all([
                this.getAllByIndex(this.MESSAGE_STORE, 'byScope', scope),
                this.getAllByIndex(this.MEDIA_STORE, 'byScope', scope)
            ]);

            await Promise.all([
                this.deleteRecords(this.MESSAGE_STORE, messages.map(record => record.id)),
                this.deleteRecords(this.MEDIA_STORE, media.map(record => record.id))
            ]);
        } catch (error) {
            console.warn('清空媒体缓存失败:', error);
        }
    },

    async syncWithHistory(messages) {
        try {
            const scope = this.getScope();
            const historyEntries = [];

            if (Array.isArray(messages)) {
                messages.forEach(msg => {
                    if (!msg || typeof msg.content !== 'string') return;
                    const role = msg.role === 'user' ? 'user' : 'bot';
                    const { normalizedContent } = this.normalizeMessageContent(msg.content);
                    const placeholderTypes = this.getPlaceholderTypes(normalizedContent);
                    historyEntries.push({
                        role,
                        lookupKey: this.buildLookupKey(scope, role, normalizedContent),
                        placeholderTypes,
                        mediaSignature: this.getMediaSignatureFromTypes(placeholderTypes),
                        textFingerprint: this.getTextFingerprint(normalizedContent)
                    });
                });
            }

            const cachedMessages = await this.getAllByIndex(this.MESSAGE_STORE, 'byScope', scope);
            const staleMessageIds = cachedMessages
                .filter(record => !this.shouldRetainCachedMessage(record, historyEntries))
                .map(record => record.id);

            await this.deleteRecords(this.MESSAGE_STORE, staleMessageIds);
            await this.deleteOrphanMedia(scope);
        } catch (error) {
            console.warn('同步媒体缓存失败:', error);
        }
    },

    async deleteOrphanMedia(scope) {
        const [messages, media] = await Promise.all([
            this.getAllByIndex(this.MESSAGE_STORE, 'byScope', scope),
            this.getAllByIndex(this.MEDIA_STORE, 'byScope', scope)
        ]);

        const usedMediaIds = new Set();
        messages.forEach(message => {
            (message.mediaRefs || []).forEach(ref => usedMediaIds.add(ref.mediaId));
        });

        const staleMediaIds = media
            .filter(record => !usedMediaIds.has(record.id))
            .map(record => record.id);

        await this.deleteRecords(this.MEDIA_STORE, staleMediaIds);
    }
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
                '<img src="$1" style="max-width: 300px; border-radius: 8px; margin: 5px 0;">'
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

    // 添加消息
    async addMessage(content, position, shouldSave = true, options = {}) {
        if (!content || typeof content !== 'string') {
            console.error('Invalid message content:', content);
            return;
        }

        const role = MediaCache.getRole(position);
        let renderContent = content;
        if (shouldSave) {
            await MediaCache.cacheMessageMedia(content, role, options);
        } else {
            renderContent = await MediaCache.restoreMessageMedia(content, role);
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
        
        try {
            markdownContent.innerHTML = MarkdownRenderer.render(renderContent);
            MarkdownRenderer.processCodeBlocks(markdownContent);
            MarkdownRenderer.processPreviewBlocks(markdownContent);
            MarkdownRenderer.bindMathCopyEvents(markdownContent);
        } catch (error) {
            console.error('Markdown parsing error:', error);
            markdownContent.textContent = renderContent;
        }
        
        messageContent.appendChild(markdownContent);
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(messageContent);
        DOM.messagesArea.appendChild(messageDiv);

        // 滚动处理
        if (position === 'right') {
            AppState.lastUserMessageElement = messageDiv;
            setTimeout(() => this.scrollMessageIntoView(messageDiv), 100);
        } else if (position === 'left' && AppState.lastUserMessageElement) {
            setTimeout(() => this.scrollMessageIntoView(AppState.lastUserMessageElement), 100);
        }
        
        // 渲染数学公式
        MarkdownRenderer.renderMath(markdownContent);
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
    async connect(ip, port, isAutoConnect = false) {
        if (!ip) {
            if (!isAutoConnect) Utils.showToast('请输入服务器地址');
            return;
        }
        
        try {
            if (AppState.wsConnection) {
                AppState.wsConnection.close();
            }
            
            const serverAddress = port ? `${ip}:${port}` : `${ip}:8081`;
            const directUrl = `ws://${serverAddress}`;
            const isDomain = /[a-zA-Z]/.test(ip);
            const proxyUrl = isDomain
                ? `wss://hws.maliya.top/proxy?url=${encodeURIComponent(directUrl)}`
                : `wss://sfws.maliy.top?url=${encodeURIComponent(directUrl)}`;
            const wsUrl = window.location.protocol === 'https:' ? proxyUrl : directUrl;

            AppState.wsConnection = new WebSocket(wsUrl);
            
            const connectionTimeout = setTimeout(() => {
                if (!AppState.wsConnected) {
                    AppState.wsConnection.close();
                    if (!isAutoConnect) Utils.showToast('连接超时，请检查IP和端口是否正确');
                    this.updateStatus('未连接', '#f44336');
                }
            }, 5000);
            
            AppState.wsConnection.onopen = () => {
                clearTimeout(connectionTimeout);
                AppState.wsConnected = true;
                AppState.wsAuthenticated = false;
                this.updateStatus('认证中', '#ff9800');
                
                this.startAutoReconnect();
                
                // 发送密码验证
                const password = document.getElementById('ws-password')?.value.trim();
                AppState.wsConnection.send(JSON.stringify({ type: 'auth', password }));
            };
            
            AppState.wsConnection.onclose = () => {
                AppState.wsConnected = false;
                AppState.wsAuthenticated = false;
                this.updateStatus('未连接', '#f44336');
                if (!isAutoConnect) Utils.showToast('连接已断开');
            };
            
            AppState.wsConnection.onerror = (error) => {
                console.error('[sf插件] WebSocket错误:', error);
                if (!isAutoConnect) Utils.showToast('连接失败，请确保服务器已启动');
                this.updateStatus('未连接', '#f44336');
                AppState.wsAuthenticated = false;
                MessageManager.removeTypingIndicator();
            };
            
            AppState.wsConnection.onmessage = (event) => this.handleMessage(event);
            
        } catch (error) {
            if (!isAutoConnect) Utils.showToast('连接失败: ' + error.message);
            this.updateStatus('未连接', '#f44336');
            MessageManager.removeTypingIndicator();
        }
    },

    // 请求服务端历史记录
    requestHistory() {
        if (!AppState.wsConnection || !AppState.wsAuthenticated) return;

        const userQQ = document.getElementById('user-qq')?.value.trim() || 'web_user';
        AppState.wsConnection.send(JSON.stringify({
            type: 'loadHistory',
            userQQ: userQQ,
            timestamp: Date.now()
        }));
    },

    // 处理消息
    async handleMessage(event) {
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
                MessageManager.clearMessages();
                await MediaCache.syncWithHistory(msgObj.messages);
                if (Array.isArray(msgObj.messages)) {
                    MediaCache.beginRestoreBatch();
                    try {
                        for (const msg of msgObj.messages) {
                            if (msg && msg.content) {
                                await MessageManager.addMessage(msg.content, msg.role === 'user' ? 'right' : 'left', false);
                            }
                        }
                    } finally {
                        MediaCache.endRestoreBatch();
                    }
                }
                MessageManager.removeTypingIndicator();
            } else if (msgObj.type === 'historyCleared') {
                await MediaCache.clearCurrentScope();
                MessageManager.clearMessages();
                Utils.showToast('历史记录已清空');
            } else if (msgObj.type === 'typing') {
                if (msgObj.active) {
                    MessageManager.showTypingIndicator();
                } else {
                    MessageManager.removeTypingIndicator();
                }
            } else if (typeof msgObj.content === 'string' && msgObj.content.trim()) {
                MessageManager.removeTypingIndicator();
                await MessageManager.addMessage(msgObj.content.trim(), 'left', true);
            }
        } catch (error) {
            console.error('[sf插件] 处理消息错误:', error);
            Utils.showToast('处理消息时出错');
            MessageManager.removeTypingIndicator();
        }
    },

    // 发送消息
    send(message, images = []) {
        if (!AppState.wsConnected) {
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

// ========== 事件绑定 ==========
const EventBinder = {
    init() {
        // 发送消息
        DOM.sendButton?.addEventListener('click', () => this.handleSend());
        
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
            if (await Utils.showConfirm('确定要清空当前页面吗？')) {
                const userQQ = document.getElementById('user-qq')?.value.trim() || 'web_user';
                await MediaCache.clearCurrentScope();
                if (AppState.wsConnected && AppState.wsAuthenticated) {
                    AppState.wsConnection.send(JSON.stringify({ type: 'clearHistory', userQQ }));
                    Utils.showToast('正在清空历史记录...');
                } else {
                    MessageManager.clearMessages();
                    Utils.showToast('页面已清空（未连接服务器）');
                }
            }
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
    async handleSend() {
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
        
        // 显示用户消息
        await MessageManager.addMessage(displayContent, 'right', true, {
            historyContent: MediaCache.buildOutgoingHistoryContent(message, images.length)
        });
        
        // 发送到服务器
        if (WebSocketManager.send(message, images)) {
            if (message === MediaCache.CLEAR_HISTORY_COMMAND) {
                await MediaCache.clearCurrentScope();
            }
            DOM.messageInput.value = '';
            Utils.autoResizeInput(DOM.messageInput);
            ImageManager.clearPreviews();
            MessageManager.showTypingIndicator();
        }
    },

    // 移动端支持 — 输入区留在 flex 流，只同步键盘后的 app 可见高度
    initMobileSupport() {
        const isMobileLayout = () => window.matchMedia('(max-width: 768px)').matches;
        const root = document.documentElement;
        const input = DOM.messageInput;
        const minAppHeight = 320;
        const keyboardThreshold = 80;
        let pendingFrame = 0;
        let inputFocused = false;
        let closedViewportHeight = 0;
        let focusBaselineHeight = 0;
        let lastFocusTime = 0;
        let virtualKeyboard = null;

        try {
            if (navigator.virtualKeyboard) {
                navigator.virtualKeyboard.overlaysContent = true;
                virtualKeyboard = navigator.virtualKeyboard;
            }
        } catch (error) {
            console.warn('VirtualKeyboard API 不可用:', error);
        }

        const clampHeight = (height) => Math.max(minAppHeight, Math.round(height || 0));

        const readViewportHeight = () => {
            const height = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
            return clampHeight(height);
        };

        const readVirtualKeyboardAppHeight = () => {
            const rect = virtualKeyboard?.boundingRect;
            const height = rect?.height || 0;
            if (height < keyboardThreshold) return 0;

            const viewportTop = window.visualViewport?.offsetTop || 0;
            const keyboardTop = Math.round(rect.top || 0);
            if (keyboardTop > viewportTop + keyboardThreshold) {
                return clampHeight(keyboardTop - viewportTop);
            }

            const baselineHeight = focusBaselineHeight || closedViewportHeight || readViewportHeight();
            return clampHeight(baselineHeight - height);
        };

        const estimateKeyboardHeight = (height) => {
            const available = Math.max(0, height - minAppHeight);
            if (!available) return 0;

            const estimated = Math.round(height * 0.42);
            return Math.min(Math.max(estimated, 260), Math.min(420, available));
        };

        const syncClosedViewportHeight = (height) => {
            if (!closedViewportHeight || Math.abs(closedViewportHeight - height) > 96) {
                closedViewportHeight = height;
                return;
            }

            closedViewportHeight = Math.max(closedViewportHeight, height);
        };

        const captureFocusBaseline = () => {
            const height = readViewportHeight();
            closedViewportHeight = height;
            focusBaselineHeight = height;
            lastFocusTime = Date.now();
        };

        const getAppHeight = () => {
            const viewportHeight = readViewportHeight();

            if (!inputFocused) {
                syncClosedViewportHeight(viewportHeight);
                focusBaselineHeight = 0;
                return viewportHeight;
            }

            const baselineHeight = focusBaselineHeight || closedViewportHeight || viewportHeight;
            const virtualKeyboardAppHeight = readVirtualKeyboardAppHeight();
            if (virtualKeyboardAppHeight) {
                return virtualKeyboardAppHeight;
            }

            const viewportShrink = baselineHeight - viewportHeight;
            if (viewportShrink >= keyboardThreshold) {
                return viewportHeight;
            }

            if (Date.now() - lastFocusTime < 120) {
                return viewportHeight;
            }

            return clampHeight(baselineHeight - estimateKeyboardHeight(baselineHeight));
        };

        const update = () => {
            pendingFrame = 0;
            if (isMobileLayout()) {
                root.style.setProperty('--app-height', getAppHeight() + 'px');
            } else {
                root.style.removeProperty('--app-height');
                closedViewportHeight = 0;
                focusBaselineHeight = 0;
            }
        };

        const scheduleUpdate = () => {
            if (pendingFrame) return;
            pendingFrame = requestAnimationFrame(update);
        };

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', scheduleUpdate);
        }

        virtualKeyboard?.addEventListener?.('geometrychange', scheduleUpdate);
        window.addEventListener('resize', scheduleUpdate);
        window.addEventListener('orientationchange', () => {
            closedViewportHeight = 0;
            focusBaselineHeight = 0;
            [80, 250, 600].forEach(delay => setTimeout(scheduleUpdate, delay));
        });

        input?.addEventListener('focus', () => {
            inputFocused = true;
            captureFocusBaseline();
            scheduleUpdate();
            [80, 250, 600].forEach(delay => setTimeout(scheduleUpdate, delay));
        });
        input?.addEventListener('blur', () => {
            inputFocused = false;
            [120, 300, 600].forEach(delay => setTimeout(scheduleUpdate, delay));
        });
        input?.addEventListener('input', scheduleUpdate);

        scheduleUpdate();
    },
};

// ========== 应用初始化 ==========
const App = {
    init() {
        DOM.init();
        MarkdownRenderer.init();
        EventBinder.init();
        SettingsManager.load();
        this.registerServiceWorker();
    },

    registerServiceWorker() {
        // 只在 http/https 协议下注册 ServiceWorker（本地 file:// 不支持）
        if ('serviceWorker' in navigator && location.protocol !== 'file:') {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js')
                    .catch(err => console.warn('ServiceWorker 注册失败:', err));
            });
        }
    }
};

// 启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
