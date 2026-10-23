# Porchlight

A small Discord-style chat for friends. People create their own accounts and log in with a username and password.

- Servers with channels, group chats and direct messages
- Invite codes to join a server or group
- Photo sharing (PNG, JPG, GIF, WebP)
- Live messages and "is typing" notices
- Works on phones and in light or dark mode

It is a Node.js app that stores everything in a PostgreSQL database.

---

## Put it online with Render (about 15 minutes, no coding)

You need two free accounts: **GitHub** (holds the files) and **Render** (runs the site).

### 1. Upload the files to GitHub
1. Unzip this folder on your computer.
2. Sign in at github.com and click **New repository**. Name it `porchlight`. Private is fine. Click **Create repository**.
3. On the new repository page, click **uploading an existing file**.
4. Open the unzipped folder and select **everything inside it** (`server.js`, `db.js`, `package.json`, `package-lock.json`, `render.yaml`, `README.md`, `.gitignore` and the `public` folder). Drag it all into the GitHub page.
   `render.yaml` must end up at the top level of the repository, not inside another folder.
5. Click **Commit changes**.

### 2. Deploy on Render
1. Sign up at render.com. Choosing **Sign in with GitHub** is easiest.
2. Click **New +**, then **Blueprint**.
3. Connect your `porchlight` repository when asked, then click **Apply** or **Deploy Blueprint**.
4. Render creates a database called `porchlight-db` and a web service called `porchlight`. The first build takes a few minutes.
5. When the service shows **Live**, open it and click the address at the top. It looks like `https://porchlight-xxxx.onrender.com`. That is your site.

### 3. Use it
1. Open your address and choose **Create account**.
2. Click the **+** button, then **Start a server** or **New group chat**.
3. Click **Invite** and send your friends two things: the site address and the invite code.
4. Each friend creates their own account, chooses **Join with a code**, and types the code.

---

## What the free plan means

Render's free plan has limits. These come from Render's own free-tier page, so check it for current details.

- **The site sleeps after 15 minutes with no visitors.** The next visit takes about a minute to wake it. Chat works normally once it is awake.
- **The free database expires 30 days after it is created.** After that it stops working. You then have 14 days to upgrade it to a paid plan, and after that Render deletes it and all your messages. If you want to keep your chat, upgrade the database to a paid plan in the Render dashboard before the 30 days are up.
- **The free database holds 1 GB.** Photos are stored in the database and are shrunk to at most 1600 pixels wide before upload, so this lasts a long time for a small group.
- **Free web services get 750 hours per month.** One always-on service uses about 730, so it is enough for one site.

Paid plans remove the sleeping and the expiry. You can upgrade from the Render dashboard at any time without changing any code.

---

## Good to know

- **There is no password reset.** The site does not collect email addresses, so it cannot email a reset link. If someone forgets their password, they need a new account.
- **Photos can be seen by members of the space they were posted in.** Nobody else can open a photo's address, even if they have the link.
- **Anyone with an invite code can join.** Use **Make a new code** (owner only) to stop an old code working.
- **Deleting a message deletes its photo.** Leaving a space does not delete your old messages.
- **Moderation is basic.** Only message authors can delete their own messages. Servers have no kick or ban tool yet.

---

## Run it on your own computer (optional)

You need Node.js 18 or newer and a PostgreSQL database.

```
npm install
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/porchlight npm start
```

Then open http://localhost:3000. The tables are created automatically on first start. If your database does not use SSL and is not on `localhost`, also set `PGSSL=off`.

---

## How it is built

| File | What it does |
| --- | --- |
| `server.js` | The web server: accounts, sessions, spaces, messages, photos, live updates over WebSocket |
| `db.js` | Connects to PostgreSQL and creates the tables |
| `public/index.html`, `app.js`, `style.css` | The chat page people see |
| `render.yaml` | Tells Render to create the database and the site together |

Passwords are hashed with bcrypt. Login sessions use a random token in an HttpOnly cookie, and only a hash of that token is stored. Login and invite-code attempts are rate limited, and cross-site requests are blocked.
