// public/ui.js — the UI contract's components, one implementation each.
//
// Every migrated screen builds itself from here. The contract and the reasoning
// behind each component live in docs/ui-contract.md; this is the code.
//
// Repo convention: createUi(deps). app.js passes its own helpers in (el, t,
// plural, tabStrip) rather than this module reaching into app.js's scope, so it
// can be unit-tested against fakes.
//
// Everything is scoped under the `ui` marker class, which is why `page()` and
// every body-level overlay put it on their root — see css/components.css.

(function (root) {
  'use strict';

  function createUi(deps) {
    var el = deps.el;
    var t = deps.t;
    var plural = deps.plural;
    var tabStrip = deps.tabStrip;
    var getLocale = deps.getLocale || function () { return 'en'; };

    // ---- Time: ONE formatter -------------------------------------------------
    // Three shapes of the same clock, because a table column has 110px and a
    // Drawer has room for the year — but one place decides what each looks like,
    // so two screens can never disagree about what a timestamp reads as.
    var LOCALE_TAG = { en: 'en-GB', da: 'da-DK' };
    function tag() { return LOCALE_TAG[getLocale()] || 'en-GB'; }
    function asDate(value) {
      if (value === null || value === undefined || value === '') return null;
      var d = value instanceof Date ? value : new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    var fmt = {
      // Full: the Drawer, a detail panel, anywhere the reader is reading.
      abs: function (value) {
        var d = asDate(value);
        return d ? d.toLocaleString(tag()) : '—';
      },
      // Short: a table column. Day, month, hour, minute — no year, no seconds.
      short: function (value) {
        var d = asDate(value);
        if (!d) return '—';
        return d.toLocaleString(tag(), {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
      },
      // A calendar date, no clock: a licence expiry, a release date — anything
      // where a minute would read as precision the value does not have.
      date: function (value) {
        var d = asDate(value);
        if (!d) return '—';
        return d.toLocaleDateString(tag(), { year: 'numeric', month: '2-digit', day: '2-digit' });
      },
      // Clock only: a series of readings inside one day.
      clock: function (value) {
        var d = asDate(value);
        if (!d) return '—';
        return d.toLocaleTimeString(tag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      },
      // "4 minutes ago". Translated by the catalogue, not built here.
      rel: function (value) {
        return deps.relativeTime ? deps.relativeTime(value) : fmt.short(value);
      },
      // A span in words: 1.4 s, 740 ms, 2 min.
      duration: function (ms) {
        var n = Number(ms);
        if (!isFinite(n)) return '—';
        if (n < 1000) return Math.round(n) + ' ms';
        if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + ' s';
        return Math.round(n / 60000) + ' min';
      },
    };

    // ---- Tokens at runtime ----------------------------------------------------
    // A canvas or a map library wants a colour STRING, not var(--ok) — so the
    // token is resolved here rather than a hex being written into the view. That
    // is the difference between a marker that follows the theme and one that
    // stays green on a palette where green means something else.
    var tokenCache = {};
    var tokenTheme = null;
    function token(name, fallback) {
      if (typeof document === 'undefined' || !document.documentElement) return fallback || '';
      var theme = document.documentElement.getAttribute('data-theme') || '';
      // The cache is per theme: the same token is a different colour after a
      // palette switch, and a stale one is exactly the bug this helper exists
      // to stop.
      if (theme !== tokenTheme) { tokenCache = {}; tokenTheme = theme; }
      if (tokenCache[name] !== undefined) return tokenCache[name];
      var v = '';
      try { v = getComputedStyle(document.documentElement).getPropertyValue(name); } catch (e) { v = ''; }
      v = String(v || '').trim() || fallback || '';
      tokenCache[name] = v;
      return v;
    }
    // The health verdicts, as colours a map can draw with.
    var HEALTH_TOKEN = {
      ok: '--sev-ok', warn: '--sev-warn', bad: '--sev-crit', down: '--sev-crit',
      stale: '--text-muted', unknown: '--text-muted',
    };
    function healthColor(status) { return token(HEALTH_TOKEN[status] || '--text-muted'); }

    // ---- Page root -----------------------------------------------------------
    // Carries both markers: `ui` scopes the components, `ui-page` is the column
    // layout. An overlay carries `ui` and its own layout class instead.
    function page() {
      return el.apply(null, [ 'div', { class: 'ui ui-page' } ].concat([].slice.call(arguments)));
    }

    // ---- PageHeader ----------------------------------------------------------
    function pageHeader(opts) {
      var head = el('header', { class: 'page-head' });
      var title = el('h1', {}, opts.title);
      if (opts.status) title.append(opts.status); // template D: the record's state
      if (opts.help) title.append(helpButton(opts.help));
      head.append(el('div', {}, title, opts.lead ? el('p', {}, opts.lead) : null));
      var actions = (opts.actions || []).filter(Boolean);
      if (actions.length) head.append(el('div', { class: 'page-head-actions' }, actions));
      return head;
    }

    // The (?) popover that replaced the info banner. One open at a time; Escape
    // and an outside click close it.
    var openPopover = null;
    function closePopover() {
      if (!openPopover) return;
      document.removeEventListener('keydown', onPopoverKey);
      document.removeEventListener('click', onPopoverClick, true);
      openPopover.remove();
      openPopover = null;
    }
    function onPopoverKey(e) { if (e.key === 'Escape') closePopover(); }
    function onPopoverClick(e) {
      if (openPopover && !openPopover.contains(e.target) && !e.target.closest('.help-btn')) closePopover();
    }
    function helpButton(help) {
      var btn = el('button', {
        class: 'help-btn', type: 'button', 'aria-label': help.title,
        onclick: function (e) {
          e.stopPropagation();
          if (openPopover) { closePopover(); return; }
          var pop = el('div', { class: 'ui ui-popover', role: 'dialog', 'aria-label': help.title },
            el('button', {
              class: 'btn btn-ghost btn-icon btn-xs pop-close', type: 'button',
              'aria-label': t('ui.close'), onclick: closePopover,
            }, '✕'),
            el('h3', {}, help.title),
            typeof help.body === 'function' ? help.body() : help.body);
          document.body.append(pop);
          var r = btn.getBoundingClientRect();
          pop.style.top = (r.bottom + 8) + 'px';
          pop.style.left = Math.max(8, r.left - 8) + 'px';
          openPopover = pop;
          document.addEventListener('keydown', onPopoverKey);
          document.addEventListener('click', onPopoverClick, true);
        },
      }, '?');
      return btn;
    }

    // ---- SubTabs -------------------------------------------------------------
    // app.js's tabStrip() is the only builder (it owns the roving tabindex, the
    // arrow keys and the tablist role); components.css gives it the underline.
    function tabs(items, opts) { return tabStrip(items, opts || {}); }

    // ---- StatStrip -----------------------------------------------------------
    function statStrip(cards) {
      return el('div', { class: 'statstrip' }, cards.filter(Boolean).map(function (c) {
        return el('button', {
          class: 'stat-card' + (c.tone ? ' ' + c.tone : ''),
          type: 'button',
          'aria-pressed': String(!!c.active),
          title: c.title || null,
          onclick: c.onclick,
        }, el('span', { class: 'stat-n' }, String(c.value)), el('span', { class: 'stat-l' }, c.label));
      }));
    }

    // ---- Toolbar -------------------------------------------------------------
    function toolbar(opts) {
      var bar = el('div', { class: 'toolbar-ui' }, (opts.filters || []).filter(Boolean));
      var actions = (opts.actions || []).filter(Boolean);
      if (actions.length) bar.append(el('div', { class: 'toolbar-right' }, actions));
      return bar;
    }
    // A filter with its label beside it, at --control-h like every other control.
    function filter(label, control) {
      return el('label', { class: 'field-inline' }, label, control);
    }
    // `multiple: true` turns it into a multi-picker: pass `values` (an array)
    // instead of `value`, give it a `size` so it does not render one row tall,
    // and read the answer back with ui.selected(node).
    function select(opts) {
      var many = !!opts.multiple;
      var chosen = many
        ? (opts.values || []).map(function (v) { return String(v); })
        : null;
      return el('select', {
        'aria-label': opts.label || null, id: opts.id || null,
        onchange: opts.onchange || null,
        multiple: many ? 'multiple' : null,
        size: opts.size ? String(opts.size) : null,
      }, opts.options.map(function (o) {
        var value = Array.isArray(o) ? o[0] : o;
        var text = Array.isArray(o) ? o[1] : o;
        var attrs = { value: String(value) };
        var on = many
          ? chosen.indexOf(String(value)) !== -1
          : String(value) === String(opts.value);
        if (on) attrs.selected = 'selected';
        return el('option', attrs, text);
      }));
    }

    // A multi-select you can actually read.
    //
    // The native <select multiple> shows a scrolling box three to eight rows
    // tall: the chosen entries are a blue block you cannot scan, most options
    // are off-screen, and on a fleet with forty agents it is unusable. This is
    // the same data as removable pills plus a filterable list you can tick
    // — no dependency, no new idiom, and the value is still read with
    // ui.selected().
    //
    // The DOM keeps a real (hidden) <select multiple> underneath, so
    // ui.selected(), form serialisation and every existing caller keep working
    // unchanged; the visible half only ever writes back into it.
    function multiSelect(opts) {
      var options = (opts.options || []).map(function (o) {
        return Array.isArray(o) ? { value: String(o[0]), text: String(o[1]) } : { value: String(o), text: String(o) };
      });
      var chosen = {};
      (opts.values || []).forEach(function (v) { chosen[String(v)] = true; });

      var hidden = select({
        id: opts.id || null, label: opts.label || null, multiple: true,
        options: options.map(function (o) { return [o.value, o.text]; }),
        values: Object.keys(chosen),
      });
      hidden.classList.add('ms-value');

      var chips = el('div', { class: 'ms-picks' });
      var list = el('div', { class: 'ms-list', role: 'listbox', 'aria-multiselectable': 'true' });
      var search = el('input', {
        type: 'search', class: 'ms-search', autocomplete: 'off',
        placeholder: opts.searchPlaceholder || 'Filter…',
        'aria-label': opts.searchPlaceholder || 'Filter the options',
      });
      var summary = el('span', { class: 'ms-summary' });

      function apply() {
        Array.prototype.forEach.call(hidden.options, function (o) { o.selected = !!chosen[o.value]; });
        if (opts.onchange) opts.onchange(Object.keys(chosen));
      }

      function draw() {
        var picked = options.filter(function (o) { return chosen[o.value]; });
        chips.replaceChildren.apply(chips, picked.length
          ? picked.map(function (o) {
            return el('button', {
              type: 'button', class: 'ms-pick', title: opts.removeTitle || 'Remove',
              onclick: function () { delete chosen[o.value]; apply(); draw(); },
            }, o.text, el('span', { class: 'ms-x', 'aria-hidden': 'true' }, '\u00d7'));
          })
          : [el('span', { class: 'ms-none' }, opts.emptyText || 'None selected')]);

        var q = search.value.trim().toLowerCase();
        var visible = options.filter(function (o) { return !q || o.text.toLowerCase().indexOf(q) !== -1; });
        list.replaceChildren.apply(list, visible.length
          ? visible.map(function (o) {
            var on = !!chosen[o.value];
            return el('button', {
              type: 'button', role: 'option', 'aria-selected': on ? 'true' : 'false',
              class: 'ms-opt' + (on ? ' is-on' : ''),
              onclick: function () {
                if (chosen[o.value]) delete chosen[o.value]; else chosen[o.value] = true;
                apply(); draw();
              },
            }, el('span', { class: 'ms-tick', 'aria-hidden': 'true' }, on ? '\u2713' : ''), o.text);
          })
          : [el('div', { class: 'ms-none' }, opts.noMatchText || 'Nothing matches')]);

        summary.textContent = picked.length + ' / ' + options.length;
      }

      search.addEventListener('input', draw);
      draw();

      var box = el('div', { class: 'ms' }, hidden, chips,
        el('div', { class: 'ms-head' }, search, summary), list);
      // The caller may still want the <select> itself (ui.selected(node)).
      box.valueNode = hidden;
      return box;
    }

    // The values a select currently holds, always as an array — so a caller
    // does not branch on whether it was built `multiple` or not.
    function selected(node) {
      // A multiSelect box: read the real <select> it keeps underneath.
      if (node && node.valueNode) return selected(node.valueNode);
      if (!node) return [];
      if (node.multiple) {
        return Array.prototype.map.call(node.selectedOptions || [], function (o) { return o.value; });
      }
      return node.value === '' || node.value == null ? [] : [node.value];
    }

    // ---- Panel ---------------------------------------------------------------
    function panel(opts) {
      var p = el('section', { class: 'panel-ui' });
      if (opts.title) {
        var head = el('div', { class: 'panel-head' }, el('h2', {}, opts.title));
        if (opts.note) head.append(el('span', { class: 'meta-xs' }, opts.note));
        var acts = (opts.actions || []).filter(Boolean);
        if (acts.length) head.append(el('div', { class: 'panel-actions' }, acts));
        p.append(head);
      }
      // CHILDREN HANDED IN BARE GET THE PANEL'S PADDING. This used to append
      // them exactly as they came, and only `.panel-body` carries padding — so
      // every caller that forgot to wrap put its content flat against the
      // panel's own border. That is not a bug one screen has: it is a default
      // that was missing, and it showed up on Diagnose, Investigate and
      // anywhere else somebody built the children by hand.
      //
      // A child that is already structural — a body, a head, a foot, a scroll
      // wrap or a nested panel — is left exactly where it is, so the 30-odd
      // callers that do wrap are untouched. Consecutive bare children go into
      // ONE body rather than one each, because `.form-sec + .form-sec` draws
      // the separator between two sections and that selector needs them to
      // stay siblings.
      var STRUCTURAL = /(^|\s)(panel-body|panel-head|panel-foot|panel-ui|table-wrap-ui)(\s|$)/;
      var kids = (opts.children || []).filter(Boolean);
      var loose = null;
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        var cls = (kid && kid.getAttribute) ? (kid.getAttribute('class') || '') : '';
        if (kid && kid.nodeType === 1 && !STRUCTURAL.test(cls)) {
          if (!loose) { loose = el('div', { class: 'panel-body' }); p.append(loose); }
          loose.append(kid);
        } else {
          loose = null;
          p.append(kid);
        }
      }
      if (opts.foot) p.append(el('div', { class: 'panel-foot' }, opts.foot));
      return p;
    }
    // Template B: the panel grid a DashboardPage lays its charts out on.
    function panelGrid() {
      return el.apply(null, [ 'div', { class: 'panel-grid' } ].concat([].slice.call(arguments)));
    }

    // ---- Button / Badge / HostLink -------------------------------------------
    function button(kind, label, opts) {
      var o = opts || {};
      var cls = 'btn btn-' + kind + (o.size ? ' btn-' + o.size : '') + (o.icon ? ' btn-icon' : '');
      var attrs = { class: cls, type: 'button' };
      if (o.onclick) attrs.onclick = o.onclick;
      if (o.disabled) attrs.disabled = 'disabled';
      if (o.title) attrs.title = o.title;
      if (o.ariaLabel) attrs['aria-label'] = o.ariaLabel;
      if (o.id) attrs.id = o.id;
      return el('button', attrs, label);
    }
    // Status / severity / state ONLY. Metadata is muted text (see `meta`).
    function badge(tone, text) { return el('span', { class: 'badge-ui ' + tone }, text); }
    function meta(text) { return el('span', { class: 'meta' }, text); }
    function metaXs(text) { return el('span', { class: 'meta-xs' }, text); }
    // A host or agent name: a text link in its own column, never a chip.
    function hostLink(label, onClick) {
      return el('a', {
        class: 'hostlink', href: '#',
        onclick: function (e) { e.preventDefault(); e.stopPropagation(); onClick(); },
      }, label);
    }

    // ---- DataTable -----------------------------------------------------------
    // `select` turns on row selection: pass { select: { onChange, isSelectable } }
    // and each row gains a checkbox, with a select-all in the header. The chosen
    // row KEYS come back through onChange and from ui.tableSelection(table).
    //
    // A row's key is `row.key` — its id, not its index — because the table is
    // re-rendered on every poll and an index would silently move the selection
    // to a different row underneath the reader.
    function dataTable(opts) {
      var sort = opts.sort;
      var selectCfg = opts.select || null;
      var chosen = selectCfg && selectCfg.selected ? new Set(selectCfg.selected.map(String)) : new Set();
      var table = el('table', { class: 'dt' });
      var boxes = [];
      var headBox = null;

      function announce() {
        // Only rows still ON SCREEN count. A poll that drops a row must drop it
        // from the selection too, or a bulk action would act on something the
        // reader can no longer see.
        var live = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
        chosen = new Set(live);
        if (headBox) {
          headBox.checked = boxes.length > 0 && live.length === boxes.length;
          headBox.indeterminate = live.length > 0 && live.length < boxes.length;
        }
        if (selectCfg && selectCfg.onChange) selectCfg.onChange(live);
      }

      table.append(el('colgroup', {}, (selectCfg ? [el('col', { style: 'width:36px' })] : []).concat(
        opts.columns.map(function (c) {
          return el('col', c.width ? { style: 'width:' + c.width } : {});
        })
      )));
      var headCells = opts.columns.map(function (c) {
        var attrs = { class: c.num ? 'col-num' : null, scope: 'col' };
        if (!c.sortable || !opts.onSort) return el('th', attrs, c.label || '');
        if (sort && sort.key === c.key) attrs['aria-sort'] = sort.dir === 'asc' ? 'ascending' : 'descending';
        attrs.onclick = function () { opts.onSort(c.key); };
        attrs.title = t('ui.sortBy');
        return el('th', attrs, c.label, el('span', { class: 'sort' },
          sort && sort.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'));
      });
      if (selectCfg) {
        headBox = el('input', {
          type: 'checkbox', class: 'dt-check',
          'aria-label': t('ui.selectAll'),
          onchange: function () {
            var on = headBox.checked;
            boxes.forEach(function (b) { b.checked = on; });
            announce();
          },
        });
        headCells = [el('th', { scope: 'col', class: 'dt-check-cell' }, headBox)].concat(headCells);
      }
      table.append(el('thead', {}, el('tr', {}, headCells)));
      var body = el('tbody', {});
      opts.rows.forEach(function (row) {
        var tr = el('tr', { 'aria-selected': 'false' });
        if (row.dimmed) tr.classList.add('is-dimmed');
        else if (opts.onOpen) tr.setAttribute('tabindex', '0');
        if (selectCfg) {
          var selectable = !row.dimmed
            && row.key != null
            && (!selectCfg.isSelectable || selectCfg.isSelectable(row));
          var box = selectable ? el('input', {
            type: 'checkbox', class: 'dt-check', value: String(row.key),
            'aria-label': t('ui.selectRow'),
            checked: chosen.has(String(row.key)) ? 'checked' : null,
            // The checkbox is not the row: ticking it must not also open the
            // drawer the row click opens.
            onclick: function (e) { e.stopPropagation(); },
            onchange: announce,
          }) : null;
          if (box) boxes.push(box);
          tr.append(el('td', { class: 'dt-check-cell' }, box));
        }
        opts.columns.forEach(function (c) {
          tr.append(el('td', { class: c.num ? 'col-num' : (c.time ? 'col-time' : null) }, row.cells[c.key]));
        });
        if (!row.dimmed && opts.onOpen) {
          var open = function (e) {
            if (e.target.closest('button') || e.target.closest('a')) return;
            opts.onOpen(row, tr);
          };
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            open(e);
          });
        }
        body.append(tr);
      });
      table.append(body);
      if (selectCfg) announce(); // the header box starts in the right state
      var wrap = el('div', { class: 'table-wrap-ui' }, table);
      if (opts.dense) wrap.classList.add('dense');
      // The chosen keys, readable straight off the returned node, so a caller
      // that did not keep the onChange values can still ask.
      wrap.selectedKeys = function () {
        return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      };
      return wrap;
    }

    // One primary action visible on hover, everything else behind the ⋯ menu —
    // this is what keeps a row from growing a stack of buttons.
    function rowActions(primary, menuItems) {
      return el('div', { class: 'row-act' },
        primary ? el('button', {
          class: 'btn btn-secondary btn-xs on-hover', type: 'button',
          onclick: function (e) { e.stopPropagation(); primary.onclick(); },
        }, primary.label) : null,
        (menuItems && menuItems.length) ? el('button', {
          class: 'btn btn-ghost btn-xs btn-icon', type: 'button', 'aria-haspopup': 'menu',
          'aria-label': t('ui.moreActions'),
          onclick: function (e) { e.stopPropagation(); openRowMenu(e.currentTarget, menuItems); },
        }, '⋯') : null);
    }

    var rowMenu = null;
    function closeRowMenu() {
      if (!rowMenu) return;
      document.removeEventListener('click', onMenuClick, true);
      document.removeEventListener('keydown', onMenuKey);
      rowMenu.remove();
      rowMenu = null;
    }
    function onMenuClick(e) { if (rowMenu && !rowMenu.contains(e.target)) closeRowMenu(); }
    function onMenuKey(e) { if (e.key === 'Escape') closeRowMenu(); }
    function openRowMenu(anchor, items) {
      closeRowMenu();
      var menu = el('div', { class: 'ui ui-rowmenu', role: 'menu' }, items.filter(Boolean).map(function (it) {
        if (it === '-') return el('hr', {});
        return el('button', {
          type: 'button', role: 'menuitem', class: it.danger ? 'danger' : null,
          onclick: function () { closeRowMenu(); it.onclick(); },
        }, it.label);
      }));
      document.body.append(menu);
      // Clamp to the VIEWPORT on both axes, and flip above the trigger when
      // there is no room below. Only the left edge was clamped, so a menu on a
      // right-hand column ran off the window (its labels cut in half) and one on
      // the last row opened below the fold.
      var r = anchor.getBoundingClientRect();
      // `document.defaultView`, not the bare `window` global: this module is
      // driven from a document the caller supplies, and a free `window` is a
      // ReferenceError there — which threw AFTER the menu was in the DOM but
      // before it was tracked, leaving a menu nothing could close.
      var vp = document.defaultView || {};
      var docEl = document.documentElement || {};
      var vw = vp.innerWidth || docEl.clientWidth || 0;
      var vh = vp.innerHeight || docEl.clientHeight || 0;
      var w = menu.offsetWidth;
      var h = menu.offsetHeight;
      var left = vw ? Math.min(Math.max(8, r.right - w), Math.max(8, vw - w - 8)) : Math.max(8, r.right - w);
      var below = r.bottom + 4;
      var top = below;
      if (vh) {
        top = (below + h > vh - 8 && r.top - h - 4 >= 8) ? (r.top - h - 4) : Math.min(below, Math.max(8, vh - h - 8));
      }
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      rowMenu = menu;
      setTimeout(function () {
        document.addEventListener('click', onMenuClick, true);
        document.addEventListener('keydown', onMenuKey);
      }, 0);
    }

    // ---- Drawer --------------------------------------------------------------
    var drawerEls = null;
    function closeDrawer() {
      if (!drawerEls) return;
      document.removeEventListener('keydown', onDrawerKey);
      drawerEls.scrim.remove();
      drawerEls.panel.remove();
      if (drawerEls.row) drawerEls.row.setAttribute('aria-selected', 'false');
      if (drawerEls.returnTo && typeof drawerEls.returnTo.focus === 'function') drawerEls.returnTo.focus();
      drawerEls = null;
    }
    function onDrawerKey(e) { if (e.key === 'Escape') closeDrawer(); }
    function openDrawer(o) {
      var returnTo = document.activeElement;
      closeDrawer();
      var scrim = el('div', { class: 'ui ui-scrim', onclick: closeDrawer });
      var panelEl = el('aside', {
        class: 'ui ui-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title,
      },
      el('div', { class: 'drawer-head' },
        el('div', { class: 'drawer-head-text' },
          el('h2', {}, o.title),
          el('div', { class: 'drawer-meta' }, o.status || null, o.meta ? metaXs(o.meta) : null)),
        el('button', {
          class: 'btn btn-ghost btn-icon drawer-x', type: 'button',
          'aria-label': t('ui.close'), onclick: closeDrawer,
        }, '✕')),
      el('div', { class: 'drawer-body' }, (o.sections || []).filter(Boolean)),
      o.footer || null);
      document.body.append(scrim, panelEl);
      if (o.row) o.row.setAttribute('aria-selected', 'true');
      drawerEls = { scrim: scrim, panel: panelEl, row: o.row || null, returnTo: returnTo };
      var first = panelEl.querySelector('button, a, [tabindex]');
      if (first && typeof first.focus === 'function') first.focus();
      document.addEventListener('keydown', onDrawerKey);
      return panelEl;
    }
    function drawerSection(title, body) {
      return el('section', { class: 'dsec' }, el('h3', {}, title), body);
    }
    function drawerFooter(left, right) {
      return el('div', { class: 'drawer-foot' },
        (left || []).filter(Boolean),
        (right && right.length) ? el('div', { class: 'foot-right' }, right.filter(Boolean)) : null);
    }
    // A key/value block: the numbers a finding rests on, in a fixed column.
    function keyValues(pairs) {
      var dl = el('dl', { class: 'kv-ui' });
      pairs.filter(Boolean).forEach(function (p) {
        dl.append(el('dt', {}, p[0]), el('dd', {}, p[1]));
      });
      return dl;
    }
    function history(entries) {
      return el('ul', { class: 'hist' }, entries.filter(Boolean).map(function (e) {
        return el('li', {}, e[0] ? el('time', {}, e[0]) : null, el('span', {}, e[1]));
      }));
    }

    // ---- FormSection ---------------------------------------------------------
    function formSection(opts) {
      var sec = el('div', { class: 'form-sec' });
      if (opts.title) sec.append(el('h3', {}, opts.title));
      if (opts.hint) sec.append(el('p', { class: 'sec-hint' }, opts.hint));
      var grid = el('div', { class: 'form-grid-ui' + (opts.single ? ' single' : '') },
        (opts.fields || []).filter(Boolean));
      sec.append(grid);
      return sec;
    }
    // Label above, hint below, error below that in --sev-crit.
    //
    // `error` is a message the caller already has; `errorNode` is an empty slot
    // the caller fills later (a form that validates on submit owns the node and
    // writes into it, rather than rebuilding the field).
    function field(opts) {
      var control = opts.control;
      if (opts.error && control && control.setAttribute) control.setAttribute('aria-invalid', 'true');
      return el('div', { class: 'f' },
        el('label', opts.id ? { for: opts.id } : {}, opts.label),
        control,
        opts.hint ? el('span', { class: 'hint' }, opts.hint) : null,
        opts.errorNode || (opts.error ? el('span', { class: 'field-error' }, opts.error) : null));
    }
    function formActions(left, right) {
      return el('div', { class: 'form-actions-ui' },
        (left || []).filter(Boolean),
        (right && right.length) ? el('div', { class: 'actions-right' }, right.filter(Boolean)) : null);
    }

    // ---- States --------------------------------------------------------------
    // Three different nothings, which must not look alike:
    //
    //   kind 'ok'     — nothing to report and that IS the good news (no open
    //                   findings, no topology changes). A tick is earned here.
    //   kind 'nodata' — a query came back empty: this window, this agent, this
    //                   filter. Not success and not a fault — the reader's next
    //                   move is to widen the search, so it says so.
    //   default       — an absence with nothing to suggest. Quiet dash.
    //
    // The tick used to be the DEFAULT, which is how "No flows in this window"
    // came to be reported with the same glyph as "everything is fine".
    var STATE_ICON = { ok: '✓', nodata: '–' };
    function emptyState(o) {
      var kind = o.kind || 'none';
      var body = o.body || (kind === 'nodata' ? t('ui.empty.widen') : null);
      return el('div', { class: 'state is-' + kind },
        el('div', { class: 'state-ico' }, o.icon || STATE_ICON[kind] || '–'),
        el('h3', {}, o.title),
        body ? el('p', {}, body) : null,
        o.action || null);
    }
    function errorState(o) {
      return el('div', { class: 'state is-error' },
        el('div', { class: 'state-ico' }, '⚠'),
        el('h3', {}, o.title || t('ui.error.title')),
        el('p', {}, o.body || t('ui.error.body'), o.detail ? [' ', el('code', {}, o.detail)] : null),
        o.onRetry ? button('primary', t('common.retry'), { onclick: o.onRetry }) : null);
    }
    // A skeleton, not a spinner: the shape of what is coming, so the page does
    // not jump when it arrives.
    function loadingState(rows, cols) {
      var n = rows || 6;
      var widths = cols || ['skel-a', 'skel-b', 'skel-c', 'skel-d', 'skel-e', 'skel-f'];
      var host = el('div', { class: 'skel-rows', 'aria-busy': 'true', 'aria-label': t('ui.loading') });
      for (var i = 0; i < n; i++) {
        host.append(el('div', { class: 'skel-row' }, widths.map(function (w) {
          return el('div', { class: 'skel ' + w });
        })));
      }
      return host;
    }
    // An advisory about the DATA, above the table. Never a banner.
    function inlineNote(text, tone) {
      return el('p', { class: 'inline-note' + (tone ? ' is-' + tone : '') }, text);
    }

    // ---- Toast ---------------------------------------------------------------
    // Top right, stacked. A confirmation goes after 5 s; an error is given
    // longer (15 s) rather than forever — a stack of errors nobody dismissed
    // ends up covering the page it is complaining about. The countdown pauses
    // while the pointer is over the stack or the focus is inside it, so an
    // error being read is never pulled away mid-sentence, and the ✕ still
    // closes one on demand.
    var TOAST_MS = { ok: 5000, err: 15000 };
    var TOAST_MAX = 4;
    var toastPaused = false;
    var liveToasts = [];

    function armToast(entry) {
      clearTimeout(entry.timer);
      if (toastPaused) return;
      var left = entry.dueAt - Date.now();
      entry.timer = setTimeout(function () { closeToast(entry); }, left > 0 ? left : 0);
    }
    function closeToast(entry) {
      clearTimeout(entry.timer);
      var i = liveToasts.indexOf(entry);
      if (i >= 0) liveToasts.splice(i, 1);
      entry.node.remove();
    }
    function pauseToasts(paused) {
      toastPaused = paused;
      liveToasts.forEach(function (entry) {
        if (paused) {
          clearTimeout(entry.timer);
          entry.remaining = Math.max(0, entry.dueAt - Date.now());
        } else {
          entry.dueAt = Date.now() + (entry.remaining === undefined ? entry.life : entry.remaining);
          entry.remaining = undefined;
          armToast(entry);
        }
      });
    }
    function toastHost() {
      var host = document.getElementById('ui-toasts');
      if (!host) {
        host = el('div', {
          class: 'ui ui-toasts', id: 'ui-toasts', role: 'status', 'aria-live': 'polite',
          onmouseenter: function () { pauseToasts(true); },
          onmouseleave: function () { pauseToasts(false); },
          onfocusin: function () { pauseToasts(true); },
          onfocusout: function () { pauseToasts(false); },
        });
        document.body.append(host);
      }
      return host;
    }

    // `opts.focus` is the form field the message is about: clicking "Run" with
    // no agent chosen should put the cursor IN the agent picker, not leave the
    // operator hunting for which of six controls the toast means. The field is
    // focused and ringed until it is touched.
    function markField(field) {
      if (!field || typeof field.focus !== 'function') return;
      field.classList.add('is-asked');
      var clear = function () {
        field.classList.remove('is-asked');
        field.removeEventListener('input', clear);
        field.removeEventListener('change', clear);
        field.removeEventListener('blur', clear);
      };
      field.addEventListener('input', clear);
      field.addEventListener('change', clear);
      field.addEventListener('blur', clear);
      if (typeof field.scrollIntoView === 'function') {
        try { field.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { field.scrollIntoView(); }
      }
      try { field.focus({ preventScroll: true }); } catch (e) { field.focus(); }
    }

    function toast(title, detail, opts) {
      var o = opts || {};
      var bad = !!o.bad;
      var key = (bad ? 'err' : 'ok') + '\u0000' + String(title) + '\u0000' + String(detail || '');
      markField(o.focus);
      // The same message twice is one message. Clicking a disabled-by-validation
      // button four times should not build a four-high stack of the same line.
      var dup = liveToasts.filter(function (e) { return e.key === key; })[0];
      if (dup) {
        dup.life = o.ttlMs || (bad ? TOAST_MS.err : TOAST_MS.ok);
        dup.dueAt = Date.now() + dup.life;
        dup.remaining = undefined;
        armToast(dup);
        return dup.node;
      }
      var node = el('div', { class: 'ui-toast ' + (bad ? 'err' : 'ok') },
        el('div', { class: 'toast-tx' },
          el('div', { class: 'toast-title' }, title),
          detail ? el('div', { class: 'toast-detail' }, detail) : null),
        el('button', {
          class: 'btn btn-ghost btn-icon btn-xs', type: 'button',
          'aria-label': t('ui.close'), onclick: function () { closeToast(entry); },
        }, '✕'));
      var life = o.ttlMs || (bad ? TOAST_MS.err : TOAST_MS.ok);
      var entry = { key: key, node: node, life: life, dueAt: Date.now() + life, timer: null };
      liveToasts.push(entry);
      toastHost().append(node);
      while (liveToasts.length > TOAST_MAX) closeToast(liveToasts[0]);
      armToast(entry);
      return node;
    }

    // ---- Chart ---------------------------------------------------------------
    // Hand-written SVG (repo convention: no chart library). The contract's three
    // rules are enforced here rather than per screen:
    //   * the legend sits under the chart and is always visible,
    //   * the y-axis is whole numbers when the data is whole numbers, stepping
    //     by 1 while the maximum is 10 or less,
    //   * few data points render as bars, because four dots joined by a line
    //     invent a trend the data does not have.
    var NS = 'http://www.w3.org/2000/svg';
    function svgEl(name, attrs) {
      var node = document.createElementNS(NS, name);
      Object.keys(attrs || {}).forEach(function (k) {
        if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, String(attrs[k]));
      });
      return node;
    }
    var BAR_THRESHOLD = 8; // at or below this many points per series, draw bars

    // A y-axis a person reads: whole numbers when the data is whole, stepping by
    // 1 up to 10, then by a round number.
    function axisTicks(max, integral) {
      if (!(max > 0)) return [0, 1];
      if (integral && max <= 10) {
        var out = [];
        for (var i = 0; i <= Math.ceil(max); i++) out.push(i);
        return out;
      }
      var pow = Math.pow(10, Math.floor(Math.log10(max)));
      var step = pow / 2;
      while (max / step > 6) step *= 2;
      var top = Math.ceil(max / step) * step;
      var ticks = [];
      for (var v = 0; v <= top + 1e-9; v += step) {
        ticks.push(integral ? Math.round(v) : Number(v.toFixed(6)));
      }
      return ticks.filter(function (v, i, a) { return a.indexOf(v) === i; });
    }

    function chart(opts) {
      var series = (opts.series || []).filter(function (s) { return s && (s.points || []).length; });
      if (!series.length) {
        return emptyState({ kind: 'nodata', title: opts.emptyTitle || t('ui.chart.empty') });
      }
      var labels = opts.labels || series[0].points.map(function (p, i) { return p.label != null ? p.label : String(i); });
      var count = Math.max.apply(null, series.map(function (s) { return s.points.length; }));
      var asBars = opts.form === 'bars' || (opts.form !== 'line' && count <= BAR_THRESHOLD);
      var values = series.reduce(function (acc, s) {
        return acc.concat(s.points.map(function (p) { return Number(p.y) || 0; }));
      }, []);
      var max = Math.max.apply(null, values.concat([0]));
      var integral = values.every(function (v) { return Number.isInteger(v); });
      var ticks = axisTicks(max, integral);
      var top = ticks[ticks.length - 1] || 1;

      var W = 760;
      var H = opts.height || 240;
      var PAD = { t: 12, r: 16, b: 30, l: 48 };
      var plotW = W - PAD.l - PAD.r;
      var plotH = H - PAD.t - PAD.b;
      var yOf = function (v) { return PAD.t + plotH - (Number(v) / top) * plotH; };

      var svg = svgEl('svg', {
        class: 'ui-chart-svg', viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': opts.title || t('ui.chart.label'),
      });

      ticks.forEach(function (v) {
        var y = yOf(v);
        svg.appendChild(svgEl('line', { class: 'ui-chart-grid', x1: PAD.l, y1: y, x2: W - PAD.r, y2: y }));
        var label = svgEl('text', { class: 'ui-chart-axis', x: PAD.l - 8, y: y + 4, 'text-anchor': 'end' });
        label.textContent = String(v);
        svg.appendChild(label);
      });

      if (asBars) {
        var slot = plotW / Math.max(1, count);
        var groupW = Math.min(52, slot - 6);
        var barW = Math.max(2, groupW / series.length);
        for (var i = 0; i < count; i++) {
          var x0 = PAD.l + i * slot + (slot - groupW) / 2;
          series.forEach(function (s, si) {
            var p = s.points[i];
            if (!p) return;
            var y = yOf(Number(p.y) || 0);
            svg.appendChild(svgEl('rect', {
              class: 'ui-chart-bar ui-series-' + (si % 6),
              x: (x0 + si * barW).toFixed(1), y: y.toFixed(1),
              width: barW.toFixed(1), height: Math.max(0, PAD.t + plotH - y).toFixed(1),
            }));
          });
        }
      } else {
        var xOf = function (i) {
          return count === 1 ? PAD.l + plotW / 2 : PAD.l + (i / (count - 1)) * plotW;
        };
        series.forEach(function (s, si) {
          var d = s.points.map(function (p, i) {
            return (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(Number(p.y) || 0).toFixed(1);
          }).join(' ');
          svg.appendChild(svgEl('path', { class: 'ui-chart-line ui-series-' + (si % 6), d: d }));
        });
      }

      // x labels: a chart with 31 of them has none, so only as many as fit.
      var every = Math.ceil(count / 8);
      labels.forEach(function (text, i) {
        if (i % every !== 0) return;
        var x = asBars
          ? PAD.l + (i + 0.5) * (plotW / Math.max(1, count))
          : (count === 1 ? PAD.l + plotW / 2 : PAD.l + (i / (count - 1)) * plotW);
        var node = svgEl('text', { class: 'ui-chart-axis', x: x.toFixed(1), y: H - 8, 'text-anchor': 'middle' });
        node.textContent = String(text);
        svg.appendChild(node);
      });

      // The legend is under the chart and always drawn — a series you cannot
      // name is a line you cannot read.
      var legend = el('div', { class: 'ui-chart-legend' }, series.map(function (s, si) {
        return el('span', { class: 'ui-legend-item' },
          el('span', { class: 'ui-legend-dot ui-series-' + (si % 6) }),
          s.label);
      }));

      return el('div', { class: 'ui-chart' }, el('div', { class: 'ui-chart-plot' }, svg), legend);
    }

    // Everything a screen has to tear down when it is left: these are appended
    // to <body>, so leaving the view does not remove them.
    function closeOverlays() { closeDrawer(); closePopover(); closeRowMenu(); }

    return {
      fmt: fmt,
      token: token,
      healthColor: healthColor,
      page: page,
      pageHeader: pageHeader,
      tabs: tabs,
      statStrip: statStrip,
      toolbar: toolbar,
      filter: filter,
      select: select,
      multiSelect: multiSelect,
      selected: selected,
      panel: panel,
      panelGrid: panelGrid,
      button: button,
      badge: badge,
      meta: meta,
      metaXs: metaXs,
      hostLink: hostLink,
      dataTable: dataTable,
      rowActions: rowActions,
      openDrawer: openDrawer,
      closeDrawer: closeDrawer,
      drawerSection: drawerSection,
      drawerFooter: drawerFooter,
      keyValues: keyValues,
      history: history,
      formSection: formSection,
      field: field,
      formActions: formActions,
      emptyState: emptyState,
      errorState: errorState,
      loadingState: loadingState,
      inlineNote: inlineNote,
      toast: toast,
      chart: chart,
      axisTicks: axisTicks,
      closeOverlays: closeOverlays,
      BAR_THRESHOLD: BAR_THRESHOLD,
    };
  }

  var apiObj = { create: createUi };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.Ui = apiObj;
})(typeof window !== 'undefined' ? window : null);
