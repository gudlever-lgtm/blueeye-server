// public/nis2Evidence.js — evidence references on a NIS2 control, risk or
// incident, built from the UI contract's components (docs/ui-contract.md). A
// Drawer the NIS2 registers open from a row; not a page
// (scripts/ui-check.js sweeps it under SECTIONS).
//
// GET/POST/DELETE /api/nis2/evidence had no caller: a control carried ONE
// free-text "evidence" field, while the API that can hold every piece of proof
// an auditor asks for — the restore-test report AND the review minutes AND the
// ticket — sat unused. This lists what is attached to one record, attaches
// another, and removes one.
//
// Privacy / scope: BlueEyes stores the REFERENCE — a title, a link or an
// absolute path, a note — never the artefact. The server refuses anything that
// is not an http(s) URL or an absolute path, and its message is shown under the
// field it is about.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Spelled out per kind: the UI gate sweeps literal t() keys.
    function kindLabel(kind) {
      return kind === 'risk' ? t('nis2ev.kind.risk')
        : kind === 'incident' ? t('nis2ev.kind.incident') : t('nis2ev.kind.control');
    }

    function link(ev) {
      var url = ev.fileUrl || '';
      // Only a web link is clickable; a path is shown as text to copy.
      if (/^https?:\/\//i.test(url)) {
        return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, ev.title);
      }
      return ev.title;
    }

    // Opens the drawer for one record. `entityType` is control | risk | incident.
    function open(entityType, entityId, label) {
      var canWrite = !!deps.canWrite();
      var listHost = el('div', {}, ui.loadingState(3));
      var formHost = el('div', {});

      function load() {
        listHost.replaceChildren(ui.loadingState(3));
        return deps.list(entityType, entityId).then(function (rows) {
          var list = Array.isArray(rows) ? rows : [];
          if (!list.length) {
            listHost.replaceChildren(ui.emptyState({ title: t('nis2ev.none'), body: t('nis2ev.noneHint') }));
            return;
          }
          listHost.replaceChildren(ui.dataTable({
            dense: true,
            columns: [
              { key: 'title', label: t('nis2ev.col.title') },
              { key: 'added', label: t('nis2ev.col.added'), width: '150px' },
              canWrite ? { key: 'act', label: '', width: '90px' } : null,
            ].filter(Boolean),
            rows: list.map(function (ev) {
              return {
                key: ev.id,
                cells: {
                  title: el('div', {}, link(ev),
                    ev.fileUrl && !/^https?:\/\//i.test(ev.fileUrl) ? el('div', {}, ui.metaXs(ev.fileUrl)) : null,
                    ev.description ? el('div', {}, ui.metaXs(ev.description)) : null),
                  added: el('div', {}, ui.fmt.short(ev.createdAt),
                    ev.uploadedByEmail ? el('div', {}, ui.metaXs(ev.uploadedByEmail)) : null),
                  act: canWrite ? ui.button('ghost', t('nis2ev.remove'), {
                    size: 'xs',
                    onclick: function () { remove(ev); },
                  }) : null,
                },
              };
            }),
          }));
        }).catch(function (e) {
          listHost.replaceChildren(ui.errorState({
            title: t('nis2ev.err'), body: deps.errText(e),
            detail: 'GET /api/nis2/evidence', onRetry: load,
          }));
        });
      }

      function remove(ev) {
        if (!deps.confirm(t('nis2ev.confirmRemove', { title: ev.title }))) return Promise.resolve();
        return deps.remove(ev.id).then(function () {
          deps.toast(t('nis2ev.removed'));
          load();
        }).catch(function (e) { deps.toast(deps.errText(e), true); });
      }

      function drawForm() {
        var inputs = {
          title: el('input', { type: 'text', id: 'nis2ev-title', maxlength: '255' }),
          fileUrl: el('input', { type: 'text', id: 'nis2ev-url', maxlength: '1024', placeholder: t('nis2ev.urlPlaceholder') }),
          description: el('textarea', { id: 'nis2ev-desc', rows: '2', maxlength: '2000' }),
        };
        var errs = {
          title: el('span', { class: 'field-error' }),
          fileUrl: el('span', { class: 'field-error' }),
          description: el('span', { class: 'field-error' }),
        };
        var formErr = el('p', { class: 'field-error' });
        var addBtn = ui.button('primary', t('nis2ev.add'), { onclick: add });

        function add() {
          Object.keys(errs).forEach(function (k) { errs[k].textContent = ''; inputs[k].removeAttribute('aria-invalid'); });
          formErr.textContent = '';
          var title = inputs.title.value.trim();
          if (!title) {
            errs.title.textContent = t('nis2ev.titleRequired');
            inputs.title.setAttribute('aria-invalid', 'true');
            return Promise.resolve();
          }
          addBtn.disabled = true;
          return deps.create({
            title: title,
            fileUrl: inputs.fileUrl.value.trim() || null,
            description: inputs.description.value.trim() || null,
            entityType: entityType,
            entityId: entityId,
          }).then(function () {
            deps.toast(t('nis2ev.added'));
            drawForm();
            load();
          }).catch(function (e) {
            addBtn.disabled = false;
            var details = e && e.data && e.data.details;
            var placed = false;
            if (details && typeof details === 'object') {
              Object.keys(details).forEach(function (k) {
                if (errs[k]) {
                  errs[k].textContent = String(details[k]);
                  inputs[k].setAttribute('aria-invalid', 'true');
                  placed = true;
                }
              });
            }
            if (!placed) formErr.textContent = deps.errText(e);
          });
        }

        formHost.replaceChildren(
          ui.formSection({
            single: true,
            fields: [
              ui.field({ id: 'nis2ev-title', label: t('nis2ev.col.title'), control: inputs.title, hint: t('nis2ev.titleHint'), errorNode: errs.title }),
              ui.field({ id: 'nis2ev-url', label: t('nis2ev.url'), control: inputs.fileUrl, hint: t('nis2ev.urlHint'), errorNode: errs.fileUrl }),
              ui.field({ id: 'nis2ev-desc', label: t('nis2ev.desc'), control: inputs.description, errorNode: errs.description }),
            ],
          }),
          formErr,
          ui.formActions([], [addBtn]));
      }

      ui.openDrawer({
        title: t('nis2ev.title', { name: label }),
        meta: kindLabel(entityType),
        sections: [
          ui.inlineNote(t('nis2ev.note')),
          ui.drawerSection(t('nis2ev.attached'), listHost),
          canWrite ? ui.drawerSection(t('nis2ev.addTitle'), formHost) : null,
        ],
      });
      if (canWrite) drawForm();
      return load();
    }

    return { open: open };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.Nis2Evidence = apiObj;
})(typeof window !== 'undefined' ? window : null);
