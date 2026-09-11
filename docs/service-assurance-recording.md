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

## When it does not work: check this first

**Is BlueEyes served over HTTPS?** If BlueEyes is on plain `http://` and the
application you are recording is on `https://`, the browser refuses the
recorder's call as **mixed active content** — before it is even attempted, and
before CSP enters into it. Almost every application worth monitoring is HTTPS,
so this stops recording everywhere.

The start dialog says so rather than handing you a bookmarklet that cannot work.
The fix is one of:

- serve BlueEyes over HTTPS;
- if a reverse proxy already terminates TLS in front of it, set
  `BLUEEYE_PUBLIC_URL` to the `https://` address people actually use. BlueEyes
  otherwise derives its own address from the incoming request, which arrives over
  plain HTTP from the proxy and so looks insecure from the outside. Setting
  `TRUST_PROXY=1` also lets it read the forwarded scheme.

In the Docker stack both go in the `.env` file beside `docker-compose.yml` — the
same one holding `DB_PASSWORD` and `SERVER_JWT_SECRET`:

```
BLUEEYE_PUBLIC_URL=https://blueeye.example.dk
TRUST_PROXY=1
```

then `docker compose up -d --build server`. Compose passes both through to the
container; a variable that is only in `.env` and not in the compose file's
`environment:` block never reaches the process, which is worth knowing before
concluding a setting "does not work".

In the console this reads:

```
Blocked loading mixed active content
"http://blueeye-server.example.dk/api/service-capture/events"
```

## When it does not work: Content-Security-Policy

Many applications set a Content-Security-Policy — a header that tells the browser
what the page is allowed to do. It can stop the recorder in two different places,
and the difference matters because only one of them is fixable.

**`script-src` — not a problem.** This is the one that stops a page loading a
script from somewhere else. It does not apply to the recorder: the bookmarklet
carries the whole recorder in itself, and a bookmarklet's code counts as *you
acting*, not as the page loading something. Browsers exempt it deliberately.

**`connect-src` — the real wall.** This is the one that says which addresses the
page may send data to. The recorder has to post what it saw back to BlueEyes, and
a site whose policy allows connections only to itself will block that. No
bookmarklet can talk its way past it; that is exactly what the policy is for.

**The badge tells you first.** If the recorder cannot send what it sees back to
BlueEyes, the badge turns amber and says so rather than counting up into a void.
Two failed attempts, not one — a single dropped packet is not worth alarming you
about. It distinguishes two cases: *never reached* (it was never going to work
from this page) and *connection lost* (it was working and stopped).

**How to tell which directive you hit.** Press F12, open **Console**, and click
the bookmark. A CSP refusal prints the directive by name:

```
Refused to connect to 'https://blueeye.kunde.dk/api/service-capture/events'
because it violates the following Content Security Policy directive:
"connect-src 'self'"
```

**If it is `connect-src`,** you have three options, cheapest first:

1. **Record on a test or staging environment** that does not set the header, then
   point the saved test at production. The test is stored as paths, not absolute
   addresses, so the same test runs against either.
2. **Ask whoever runs the application to add your BlueEyes address** to
   `connect-src`. One entry, and only for the recording — the test itself runs
   from the worker's browser and needs nothing added.
3. **Build the test in the designer.** Discovery's suggestions are usually a good
   starting point, and a recorded test and a hand-built one are the same thing
   once saved.

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

The bookmark carries the recorder's own source (about 23 KB) with the capture
key in front of it. The same code is served at `/recorder.js`, so you can read
exactly what it does before trusting it. The recorder posts what it observed to
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
