// public/views/users.js — Users, as a ListPage (template A)
// (docs/ui-contract.md).
//
// The screen is reached two ways: at /users, and as the Users section inside
// Settings. `mode: 'embedded'` is what the second one passes — the Settings
// strip already names the section, so the page drops its own PageHeader there
// and the actions move into a Toolbar. Same seam serviceAssurance.js,
// guides.js and clusterView.js use.
//
// What this migration changes:
//   * the `.section-head` held the `<h2>` and both buttons in one flex row,
//     with the explanation and up to two preconditions as loose grey
//     paragraphs under it. It is a PageHeader with the explanation as the
//     lead, "New user" as the one primary, and each precondition as an
//     InlineNote instead of a sentence in the same grey as everything else;
//   * the bare `<table>` is a DataTable, so the columns are fixed, the header
//     is sticky and a row opens the editor rather than needing the button at
//     its right end;
//   * **three badges in two columns were not states.** `viewer` / `operator` /
//     `admin` is the account's role and `superadmin` is a kind of account —
//     both are metadata, so both are text. "pending first login" and "Active"
//     ARE a state, so that one stays a Badge;
//   * the row carried up to three buttons in a `.row-actions` div. It is
//     rowActions: Edit on hover, Resend password and Delete behind the ⋯;
//   * an installation with one account (the superadmin, before anybody is
//     invited) showed a one-row table and nothing else. It says what to do.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function view() {
      var embedded = deps.mode && deps.mode() === 'embedded';
      var page = ui.page();
      var noteHost = el('div', {});
      var bodyHost = el('div', {});

      return deps.fetchAll().then(function (d) {
        var users = d.users;
        var avail = d.availability;

        var invite = avail.available
          ? ui.button('secondary', t('usr.invite'), { onclick: function () { deps.invite(); } })
          : null;
        var add = ui.button('primary', t('usr.new'), { onclick: function () { deps.edit(); } });

        if (embedded) {
          // The Settings strip already says "Users", so the page contributes a
          // toolbar rather than a second heading with the same word in it.
          page.append(ui.toolbar({ actions: [invite, add] }));
        } else {
          page.append(ui.pageHeader({
            title: t('usr.title'),
            lead: t('usr.lead'),
            help: { title: deps.help().title, body: deps.help().body },
            actions: [invite, add],
          }));
        }
        page.append(noteHost, bodyHost);

        // Why the invite button is missing, said where the button would be
        // rather than in a grey sentence three lines down.
        var notes = [];
        // "Could not tell" is not the same as "SSO is on", and an admin can act
        // on the difference — the first is something to fix, the second is how
        // the install is meant to work. The API separates them; so does this.
        if (!avail.available && avail.ssoIndeterminate) {
          notes.push(el('p', { class: 'inline-note is-warn' },
            t('usr.ssoUnknown', { method: avail.ssoMethod || t('usr.ssoUnknownMethod') }), ' ',
            deps.docsLink('auth-lockout', t('usr.ssoUnknownLink'))));
        } else if (!avail.available && avail.ssoActive) {
          notes.push(ui.inlineNote(t('usr.sso'), 'info'));
        } else if (!avail.available && !avail.mailerReady) {
          notes.push(el('p', { class: 'inline-note is-info' },
            t('usr.noMail'), ' ', deps.settingsLink('alerting', t('usr.noMailLink'))));
        }
        noteHost.replaceChildren.apply(noteHost, notes);

        if (!users.length) {
          bodyHost.replaceChildren(ui.panel({ children: [ui.emptyState({
            icon: '◎', title: t('usr.none'), body: t('usr.noneHint'),
            action: ui.button('secondary', t('usr.new'), { onclick: function () { deps.edit(); } }),
          })] }));
          return page;
        }

        // No panel title: the PageHeader already says "Users", and in Settings
        // the section strip does. A panel with no title draws no head, so the
        // count has nowhere to sit — the table is the count.
        bodyHost.replaceChildren(ui.panel({
          children: [ui.dataTable({
            columns: [
              { key: 'email', label: t('usr.col.email') },
              { key: 'name', label: t('usr.col.name'), width: '130px' },
              // A role is what the account is, not what it is doing. Badges are
              // for states, so this is text.
              // "admin · superadmin" is the longest this cell gets.
              { key: 'role', label: t('usr.col.role'), width: '190px' },
              // "pending first login" is the longest badge on the screen.
              { key: 'status', label: t('usr.col.status'), width: '182px' },
              { key: 'created', label: t('usr.col.created'), width: '140px', time: true },
              { key: 'act', label: '', width: '88px' },
            ],
            rows: users.map(function (u) {
              return {
                u: u,
                cells: {
                  email: u.email,
                  // Display only — it is what User Logs shows next to an
                  // action, so an unnamed account is worth pointing out.
                  name: u.name ? u.name : ui.meta('—'),
                  role: el('span', {}, u.role, u.protected
                    ? ui.meta(' · ' + t('usr.superadmin'))
                    : null),
                  status: u.must_change_password
                    ? ui.badge('warn', t('usr.pending'))
                    : ui.badge('ok', t('usr.active')),
                  created: ui.meta(u.created_at ? ui.fmt.short(u.created_at) : '—'),
                  // The hover primary is "Edit" on every row, protected account
                  // included: a hidden-until-hover button still holds its own
                  // width, and "Change password" made the column wide enough to
                  // push the email — the identity on this screen — into an
                  // ellipsis. Editing the superadmin IS setting its password,
                  // and the dialog says so in its title.
                  act: ui.rowActions(
                    { label: t('usr.edit'), onclick: function () { deps.edit(u); } },
                    [
                      (avail.available && u.must_change_password)
                        ? { label: t('usr.resend'), onclick: function () { deps.resend(u); } }
                        : null,
                      u.protected ? null : '-',
                      u.protected ? null : { label: t('usr.delete'), onclick: function () { deps.remove(u); }, danger: true },
                    ].filter(Boolean)),
                },
              };
            }),
            onOpen: function (r) { deps.edit(r.u); },
          })],
        }));
        return page;
      }).catch(function (e) {
        // `replaceChildren` stringifies null, so the head is left OUT of the
        // call rather than passed as null — that trap has printed the literal
        // word "null" onto three screens in this migration already.
        var parts = [];
        if (!embedded) parts.push(ui.pageHeader({ title: t('usr.title') }));
        parts.push(ui.panel({ children: [ui.errorState({
            title: t('usr.err.title'),
            body: deps.errText(e),
            detail: 'GET /users',
            onRetry: function () { return deps.rerender(); },
          })] }));
        page.replaceChildren.apply(page, parts);
        return page;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.UsersPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
