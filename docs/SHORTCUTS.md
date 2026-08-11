# The nightly "what's still not done" text

An iOS **personal automation** that calls `GET /api/outstanding` on a schedule
and messages the adults only when something is actually late.

The endpoint returns **an empty body when nothing is late**. That is the whole
design: the automation's only condition is "did I get anything back", so a quiet
night sends nothing. A reminder that arrives every evening whether or not
anything is wrong is one nobody reads by the second week.

---

## Before you start

You need the `OUTSTANDING_TOKEN` value — the one set in the Vercel API project.
It is **not** the kiosk device token and not the cron secret; all three are
separate on purpose, so a shortcut on a lost phone cannot read the board (see
`apps/api/app/auth.py`).

Check it works first, from anywhere:

```bash
curl -s -H "Authorization: Bearer $OUTSTANDING_TOKEN" \
  https://atlas-api-sigma.vercel.app/api/outstanding
```

Nothing late → **no output at all**. Something late → one line per chore:

```
LD — Take out trash (6:15 PM)
Panashe — Wash dishes / unload dishwasher (9:30 PM)
```

A `401` means the token is wrong or `OUTSTANDING_TOKEN` is unset on the server —
unset denies everyone by design, it does not fall open.

---

## Build the automation

Shortcuts app → **Automation** tab → **+** → **Time of Day**.

1. **Time of Day** — pick when you want to be told. A useful choice is a little
   after the last cutoff (10:30 PM), so one message covers the whole evening
   rather than one arriving per cutoff.
2. **Repeat: Daily**.
3. **Run Without Asking** — turn ON. Turn **Notify When Run** off once you trust
   it, or leave it on for the first few nights so you can see it firing.
4. Add these actions, in order:

| # | Action | Settings |
|---|---|---|
| 1 | **Get Contents of URL** | URL `https://atlas-api-sigma.vercel.app/api/outstanding` · Method **GET** · Headers: **Authorization** = `Bearer <OUTSTANDING_TOKEN>` |
| 2 | **If** | `Contents of URL` **has any value** |
| 3 | ↳ **Send Message** | Recipients: Panashe, Priscilla · Message: `Contents of URL` |
| 4 | **End If** | — |

That is the entire automation. No parsing, no counting — the body is either
empty or it is the message.

> **The header is the fiddly part.** In *Get Contents of URL*, expand **Show
> More**, set Method to GET, then under **Headers** tap **Add new header**. Key
> is `Authorization`, value is the word `Bearer`, a space, then the token. A
> common failure is pasting only the token without `Bearer `.

---

## ⚠ Send Message unattended is UNVERIFIED on this phone

**This needs testing before it is trusted**, and it is the one part of the chain
this repo cannot check.

iOS has historically refused to let an automation send a message with no one
watching — the shortcut runs, composes the message, and then waits at the send
step for a human. Whether it goes on its own depends on the iOS version and on
"Run Without Asking" being genuinely honoured for the Send Message action.

**How to test it properly:** set the trigger to two minutes from now, put the
phone **face down and locked**, and wait. Then check Messages.

- Message **sent** → it works unattended. Set the real time and you are done.
- Message sitting **unsent in a draft**, or nothing at all → it does not.

**If it does not work**, swap action 3 for **Send Notification**, which always
runs unattended:

| # | Action | Settings |
|---|---|---|
| 3 | **Send Notification** | Title `Chores still not done` · Body: `Contents of URL` |

That notifies the phone the automation runs on. For Priscilla, the simplest
reliable answer is the same automation built on her phone with the same token —
not ideal, but honest, and it avoids depending on a send step that may never
fire.

---

## When it goes quiet

If you stop getting messages, check in this order:

1. **Is anything actually late?** An empty body is a *success*. Run the `curl`
   above; if it returns nothing, the automation is working correctly.
2. **Automation still enabled?** iOS disables automations that error repeatedly.
3. **Token still right?** Rotating `OUTSTANDING_TOKEN` in Vercel breaks this and
   nothing else — that separation is the point. Update the header here.
4. **Did the day materialize?** No instances means no cutoffs means nothing to
   report. `DEPLOY.md` Part F.5 covers a missed night.
