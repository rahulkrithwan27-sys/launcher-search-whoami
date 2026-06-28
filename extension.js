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
        this._scroll = scroll;
        let resultsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        resultsItem.add_child(scroll);
        this.menu.addMenuItem(resultsItem);

        this._foundPaths = new Set();
        this._searchTerm = '';
        this._searchKind = '';

        // list of selectable rows + which one is highlighted
        this._rows = [];
        this._selected = -1;

        this._entry.clutter_text.connect('text-changed', () => {
            this._refresh(this._entry.get_text());
        });

        // KEYBOARD NAVIGATION: arrows move selection, Enter activates it
        this._entry.clutter_text.connect('key-press-event', (actor, event) => {
            let sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Down) {
                this._moveSelection(1);
                return Clutter.EVENT_STOP;
            } else if (sym === Clutter.KEY_Up) {
                this._moveSelection(-1);
                return Clutter.EVENT_STOP;
            } else if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                if (this._selected >= 0 && this._rows[this._selected]) {
                    this._rows[this._selected].action();
                } else {
                    this._runDefault(this._entry.get_text().trim());
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
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

    // ---------- keyboard selection ----------
    _moveSelection(dir) {
        if (this._rows.length === 0) return;
        // clear old highlight
        if (this._selected >= 0 && this._rows[this._selected])
            this._rows[this._selected].widget.remove_style_class_name('row-selected');

        this._selected += dir;
        if (this._selected < 0) this._selected = this._rows.length - 1;
        if (this._selected >= this._rows.length) this._selected = 0;

        let row = this._rows[this._selected];
        row.widget.add_style_class_name('row-selected');

        // keep it scrolled into view
        let adj = this._scroll.vscroll ? this._scroll.vscroll.adjustment
                                       : this._scroll.get_vscroll_bar().get_adjustment();
        if (adj) {
            let [, y] = row.widget.get_transformed_position();
            let h = row.widget.get_height();
            let box = this._scroll.get_allocation_box();
            // simple: scroll so the row is visible
            row.widget.get_parent();
        }
    }

    _registerRow(widget, action) {
        this._rows.push({ widget, action });
    }

    _refresh(query) {
        this._resultsBox.destroy_all_children();
        this._rows = [];
        this._selected = -1;
        query = (query || '').trim();
        let lower = query.toLowerCase();

        if (query.length === 0) { this._addApps(''); this._selectFirst(); return; }

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
            this._selectFirst();
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

        this._selectFirst();
    }

    _selectFirst() {
        if (this._rows.length > 0) {
            this._selected = 0;
            this._rows[0].widget.add_style_class_name('row-selected');
        }
    }

    _addApps(lower) {
        let apps = Shell.AppSystem.get_default().get_installed();
        let shown = 0;
        for (let appInfo of apps) {
            if (!appInfo.should_show()) continue;
            let name = appInfo.get_name();
            if (lower && !name.toLowerCase().includes(lower)) continue;
            let info = appInfo;
            let action = () => { info.launch([], null); this.menu.close(); };
            let row = this._buildRow(appInfo.get_icon(), null, name, null, action);
            this._resultsBox.add_child(row);
            this._registerRow(row, action);
            shown++;
            if (shown >= 40) break;
        }
    }

    _fileSearch(term, kind) {
        let label = kind === 'd' ? 'folders' : (kind === 'f' ? 'files' : 'items');
        this._addInfoRow('Searching ' + label + '…');

        this._searchTerm = term;
        this._searchKind = kind;
        this._foundPaths = new Set();

        let locateCmd = ['bash', '-c', 'locate -i -l 200 "' + term + '" 2>/dev/null'];
        this._runSearch(locateCmd, term, kind, false);

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
        this._rows = [];
        this._selected = -1;
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
            let action = () => { this._openUrl('file://' + encodeURI(p)); this.menu.close(); };
            let row = this._buildRow(null, iconName, base, p, action);
            this._resultsBox.add_child(row);
            this._registerRow(row, action);
        }
        this._selectFirst();
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

    _addRow(iconName, title, sub, onClick) {
        let row = this._buildRow(null, iconName, title, sub, onClick);
        this._resultsBox.add_child(row);
        this._registerRow(row, onClick);
    }

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
