const { GObject, St, Clutter, Shell, Gio, GLib } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

let _button;

const SearchButton = GObject.registerClass(
class SearchButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'App Launcher Search');

        this.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'system-status-icon',
        }));

        this._entry = new St.Entry({
            hint_text: 'Search anything…  (d: folders, f: files, > command)',
            can_focus: true,
            x_expand: true,
            style_class: 'launcher-search-entry',
        });
        let entryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        entryItem.add_child(this._entry);
        this.menu.addMenuItem(entryItem);

        this._resultsBox = new St.BoxLayout({ vertical: true });
        let scroll = new St.ScrollView({ style: 'max-height: 440px;' });
        scroll.add_actor(this._resultsBox);
        let resultsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        resultsItem.add_child(scroll);
        this.menu.addMenuItem(resultsItem);

        this._foundPaths = new Set();
        this._searchTerm = '';
        this._searchKind = '';

        this._entry.clutter_text.connect('text-changed', () => {
            this._refresh(this._entry.get_text());
        });
        this._entry.clutter_text.connect('activate', () => {
            this._runDefault(this._entry.get_text().trim());
        });

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._entry.set_text('');
                this._refresh('');
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._entry.grab_key_focus();
                    global.stage.set_key_focus(this._entry.clutter_text);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._refresh('');
    }

    _refresh(query) {
        this._resultsBox.destroy_all_children();
        query = (query || '').trim();
        let lower = query.toLowerCase();

        if (query.length === 0) { this._addApps(''); return; }

        if (query.startsWith('d:')) {
            let term = query.slice(2).trim();
            if (term.length > 0) this._fileSearch(term, 'd');
            else this._addInfoRow('Type a folder name after d:');
            return;
        }
        if (query.startsWith('f:')) {
            let term = query.slice(2).trim();
            if (term.length > 0) this._fileSearch(term, 'f');
            else this._addInfoRow('Type a file name after f:');
            return;
        }
        if (query.startsWith('/')) { this._fileSearch(query.trim(), 'any'); return; }

        if (query.startsWith('>')) {
            let cmd = query.slice(1).trim();
            if (cmd.length > 0)
                this._addRow('utilities-terminal-symbolic', 'Run command', cmd,
                    () => this._runCommand(cmd));
            return;
        }

        let mathResult = this._tryMath(query);
        if (mathResult !== null) {
            this._addRow('accessories-calculator-symbolic',
                query + ' = ' + mathResult, 'press Enter to copy',
                () => this._copyToClipboard(String(mathResult)));
        }

        if (this._looksLikeUrl(query)) {
            let url = query.startsWith('http') ? query : 'https://' + query;
            this._addRow('web-browser-symbolic', 'Open ' + query, 'go to this website',
                () => this._openUrl(url));
        }

        this._addHeader('SEARCH THE WEB');
        this._addRow('web-browser-symbolic', 'Google', query,
            () => this._openUrl('https://www.google.com/search?q=' + encodeURIComponent(query)));
        this._addRow('video-x-generic-symbolic', 'YouTube', query,
            () => this._openUrl('https://www.youtube.com/results?search_query=' + encodeURIComponent(query)));
        this._addRow('system-search-symbolic', 'DuckDuckGo', query,
            () => this._openUrl('https://duckduckgo.com/?q=' + encodeURIComponent(query)));
        this._addRow('accessories-dictionary-symbolic', 'Wikipedia', query,
            () => this._openUrl('https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(query)));

        this._addSep();
        this._addHeader('APPS');
        this._addApps(lower);
    }

    _addApps(lower) {
        let apps = Shell.AppSystem.get_default().get_installed();
        let shown = 0;
        for (let appInfo of apps) {
            if (!appInfo.should_show()) continue;
            let name = appInfo.get_name();
            if (lower && !name.toLowerCase().includes(lower)) continue;
            let info = appInfo;
            let row = this._buildRow(appInfo.get_icon(), null, name, null,
                () => { info.launch([], null); this.menu.close(); });
            this._resultsBox.add_child(row);
            shown++;
            if (shown >= 40) break;
        }
    }

    // ---------- HYBRID FILE SEARCH ----------
    _fileSearch(term, kind) {
        let label = kind === 'd' ? 'folders' : (kind === 'f' ? 'files' : 'items');
        this._addInfoRow('Searching ' + label + '…');

        this._searchTerm = term;
        this._searchKind = kind;
        this._foundPaths = new Set();

        // PASS 1 — locate (instant)
        let locateCmd = ['bash', '-c', 'locate -i -l 200 "' + term + '" 2>/dev/null'];
        this._runSearch(locateCmd, term, kind, false);

        // PASS 2 — find (catches brand-new files)
        let home = GLib.get_home_dir();
        let excludes = [
            '*/node_modules/*', '*/.cache/*', '*/.git/*', '*/.gradle/*',
            '*/.cursor/*', '*/site-packages/*', '*/.npm/*', '*/.cargo/*',
            '*/.rustup/*', '*/.vscode/*', '*/venv/*', '*/.venv/*',
            '*/.windsurf/*', '*/Android/*', '*/.local/share/Trash/*',
        ];
        let prune = excludes.map(e => '-not -path "' + e + '"').join(' ');
        let typeFlag = kind === 'd' ? '-type d ' : (kind === 'f' ? '-type f ' : '');
        let findCmd = ['bash', '-c',
            'find "' + home + '" ' + typeFlag + '-iname "*' + term + '*" ' + prune +
            ' 2>/dev/null | head -60'];
        this._runSearch(findCmd, term, kind, true);
    }

    _runSearch(cmd, term, kind, isFind) {
        try {
            let proc = Gio.Subprocess.new(cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    if (this._searchTerm !== term || this._searchKind !== kind) return;
                    let [, stdout] = p.communicate_utf8_finish(res);
                    this._mergeFileResults(stdout, term, kind);
                } catch (e) { logError(e, 'search failed'); }
            });
        } catch (e) {
            if (!isFind) this._addInfoRow('Install plocate: sudo apt install plocate');
        }
    }

    _mergeFileResults(stdout, term, kind) {
        let home = GLib.get_home_dir();
        let junk = ['/node_modules/', '/.cache/', '/.git/', '/.gradle/',
                    '/.cursor/', '/site-packages/', '/.npm/', '/.cargo/',
                    '/.rustup/', '/.vscode/', '/venv/', '/.venv/',
                    '/.windsurf/', '/Android/', '/.local/share/Trash/',
                    '/typeshed', '/third_party/'];

        let newLines = (stdout || '').split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0)
            .filter(l => l.startsWith(home))
            .filter(l => !junk.some(j => l.includes(j)));

        for (let p of newLines) {
            if (kind === 'd' || kind === 'f') {
                let isDir = GLib.file_test(p, GLib.FileTest.IS_DIR);
                if (kind === 'd' && !isDir) continue;
                if (kind === 'f' && isDir) continue;
            }
            this._foundPaths.add(p);
        }

        this._resultsBox.destroy_all_children();
        this._addHeader(kind === 'd' ? 'FOLDERS' : (kind === 'f' ? 'FILES' : 'RESULTS'));

        let all = Array.from(this._foundPaths);
        if (all.length === 0) {
            this._addInfoRow('No ' + (kind === 'd' ? 'folders' : 'files') + ' found for "' + term + '"');
            return;
        }

        let t = term.toLowerCase();
        let scored = all.map(path => {
            let base = path.split('/').pop().toLowerCase();
            let score = 0;
            let nameNoExt = base.replace(/\.[^.]+$/, '');
            if (nameNoExt === t) score += 100;
            let wordRegex = new RegExp('(^|[ _\\-.])' + t + '($|[ _\\-.])');
            if (wordRegex.test(base)) score += 50;
            if (base.startsWith(t)) score += 20;
            score += Math.max(0, 30 - path.split('/').length);
            if (!base.includes('.')) score += 10;
            return { path, score };
        });
        scored.sort((a, b) => b.score - a.score);

        for (let item of scored.slice(0, 40)) {
            let p = item.path;
            let base = p.split('/').pop();
            let iconName = (kind === 'd' || !base.includes('.'))
                ? 'folder-symbolic' : 'text-x-generic-symbolic';
            let row = this._buildRow(null, iconName, base, p,
                () => { this._openUrl('file://' + encodeURI(p)); this.menu.close(); });
            this._resultsBox.add_child(row);
        }
    }

    _runDefault(query) {
        if (query.length === 0) return;
        if (query.startsWith('f:') || query.startsWith('d:') || query.startsWith('/')) return;
        if (query.startsWith('>')) { this._runCommand(query.slice(1).trim()); this.menu.close(); return; }
        let m = this._tryMath(query);
        if (m !== null) { this._copyToClipboard(String(m)); this.menu.close(); return; }
        if (this._looksLikeUrl(query)) {
            let url = query.startsWith('http') ? query : 'https://' + query;
            this._openUrl(url); this.menu.close(); return;
        }
        this._openUrl('https://www.google.com/search?q=' + encodeURIComponent(query));
        this.menu.close();
    }

    _addHeader(text) { this._resultsBox.add_child(new St.Label({ text: text, style_class: 'launcher-section-header' })); }
    _addSep() { this._resultsBox.add_child(new St.Widget({ style_class: 'launcher-sep' })); }
    _addInfoRow(text) { this._resultsBox.add_child(new St.Label({ text: text, style: 'padding: 10px 14px; color: rgba(255,255,255,0.5);' })); }
    _addRow(iconName, title, sub, onClick) { this._resultsBox.add_child(this._buildRow(null, iconName, title, sub, onClick)); }

    _buildRow(gicon, iconName, title, sub, onClick) {
        let box = new St.BoxLayout({ style: 'spacing: 12px; padding: 6px 10px;' });
        let icon = gicon ? new St.Icon({ gicon: gicon, icon_size: 26 })
                         : new St.Icon({ icon_name: iconName, icon_size: 22 });
        box.add_child(icon);
        let textBox = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER });
        textBox.add_child(new St.Label({ text: title, style_class: 'launcher-row-title' }));
        if (sub) textBox.add_child(new St.Label({ text: sub, style_class: 'launcher-row-sub' }));
        box.add_child(textBox);
        let row = new St.Button({ style_class: 'launcher-result-row', x_expand: true, child: box });
        if (onClick) row.connect('clicked', () => { onClick(); });
        return row;
    }

    _tryMath(q) {
        if (!/^[\d+\-*/().\s%]+$/.test(q)) return null;
        if (!/[\d]/.test(q)) return null;
        try {
            let result = Function('"use strict"; return (' + q + ')')();
            if (typeof result === 'number' && isFinite(result)) return Math.round(result * 1e8) / 1e8;
        } catch (e) {}
        return null;
    }
    _looksLikeUrl(q) {
        if (q.includes(' ')) return false;
        return /^https?:\/\//.test(q) || /\.[a-z]{2,}$/i.test(q);
    }
    _openUrl(url) { Gio.AppInfo.launch_default_for_uri(url, null); }
    _runCommand(cmd) { try { GLib.spawn_command_line_async(cmd); } catch (e) { logError(e, 'run failed'); } }
    _copyToClipboard(text) { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text); }
});

function init() {}
function enable() { _button = new SearchButton(); Main.panel.addToStatusArea('launcher-search', _button); }
function disable() { if (_button) { _button.destroy(); _button = null; } }
