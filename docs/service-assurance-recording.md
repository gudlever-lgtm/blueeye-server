# Recording a user journey

BlueEyes can write a test by watching you perform the journey. You open the real
application in your own browser, sign in as yourself, click through what you want
monitored — and BlueEyes turns that into a test you can review, edit and schedule
like any other.

## How it works, from the operator's side

1. **Service Assurance → Tests → Record a journey.** Pick the application, name
   the journey the way you would describe it to a colleague ("Customer login",
   "Create case"), and start.
2. **Drag the BlueEyes Recorder button to your bookmarks bar.** It appears once,
   on the screen that starts the recording. It carries a key that works for that
   one recording and expires — usually within 30 minutes — so there is nothing to
   keep and nothing to reuse.
3. **Open the application, sign in, and click the bookmark.** A small badge
   appears in the corner of the page and counts what it sees.
4. **Perform the journey.** The recorder never clicks, types or submits anything
   itself: it only watches.
5. **Click the badge to stop**, or go back to BlueEyes and press Review.
6. **Review and save.** You get the steps as the designer's own step list. Edit,
   reorder, delete, add assertions — then save. From that moment it is an
   ordinary test: nothing about it stays "a recording".

## What is never recorded

**Passwords.** A password field is recorded as the *fact* that it was filled,
never as what you typed. The saved step reads `{{credential.password}}`, and the
test fills it at run time from the login stored on the application. So the
password does not cross the network, does not reach a log, and is not in the
database to leak.

A field counts as a password by its type *or* by what it is called — its label,
its placeholder, its name, its id, its autocomplete hint. "Adgangskode",
"Kodeord", "Password", "PIN-kode" all count, in any of those places. The rule is
deliberately generous: if BlueEyes mistakes an ordinary field for a password you
fix one step in the designer, which is much cheaper than the other mistake.

The same goes for the username beside it: it becomes `{{credential.username}}`,
so the test runs as the application's monitoring login rather than being pinned
to whoever happened to record it.

Also never recorded: cookies, browser storage, request or response bodies,
headers, or the page's HTML. Only interactions, and only enough about each
element to find it again.

## What gets tidied up automatically

- **Typing collapses.** Typing "admin" is one step with the final value, not five
  steps building it up letter by letter.
- **The focusing click disappears.** Clicking into a field and typing produces
  both a click and an input on the same element; the fill already implies
  reaching the field. A click on a real button or link is never dropped.
- **A page you landed on becomes a check, not a jump.** If clicking "Log ind"
  took you to `/dashboard`, the test records "we should end up on /dashboard" —
  not "go to /dashboard". Otherwise the test would pass even when the login it
  is meant to verify has failed.
- **Addresses become paths.** `https://portal.kunde.dk/login` is recorded as
  `/login`, so the test runs against whichever environment you point it at. A
  link to a *different* host is kept whole — rewriting that one would point the
  step at the wrong site.

## When it does not work

Some applications set a strict Content-Security-Policy that refuses to load
scripts from anywhere but themselves. On those sites the bookmark will do
nothing, and you will get an alert saying so. That is the site's security policy
working correctly, not a fault in BlueEyes. Build the test in the designer
instead — Discovery's suggestions are usually a good starting point.

**After a full page change, click the bookmark again.** A bookmarklet lives in
the page it was injected into, so a normal page load (as opposed to a
single-page app moving between views) removes it and the badge disappears.
Clicking the bookmark again resumes the *same* recording — the steps keep
accumulating, nothing is lost, and the new page is recorded as the next step.
Applications that never do a full page load need this only once.

The recorder also needs the page to be one you can reach in a normal browser. It
does not work inside another app's embedded webview, and it stops when the
recording expires.

## Who can do what

| | Viewer | Operator | Admin |
| --- | --- | --- | --- |
| See recordings in progress | ✓ | ✓ | ✓ |
| Start, review, save, delete a recording | | ✓ | ✓ |
| Create the login a recorded journey uses | | | ✓ |

An operator reviewing a journey that signs in must attach one of the
application's stored logins before saving. They can see which logins exist
(name and username — never the password); creating one is an administrator's job.

## For the technically curious

The bookmark injects one script tag pointing at this server's `/recorder.js`,
carrying the capture key on the tag. The recorder posts what it observed to
`/api/service-capture/events`. That path is the one Service Assurance endpoint
without a login, because its caller is a script on your application's page, which
has no BlueEyes session. It is bounded accordingly: the key is stored only as a
hash, it works only while the recording is live and unexpired, it can only append
to the one recording it names, and everything it sends is size-limited and
stripped of anything BlueEyes does not recognise. Passwords are stripped again on
arrival, on the server, so the rule holds even if the browser-side script is
replaced.

The design reasoning — including why a bookmarklet rather than a browser
extension or a remote browser — is in
[service-assurance-v2.md](service-assurance-v2.md) §1.
