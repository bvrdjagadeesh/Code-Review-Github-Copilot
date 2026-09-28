// Canvas renderer: serves a minimal HTML shell. The real UI lives in the
// sibling `styles.css` and `client.js` files, which the shell loads over the
// same loopback server.

export function renderHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Azure DevOps PRs</title>
<link rel="stylesheet" href="./app.css" />
</head>
<body>
<div id="root">
  <div class="boot">Loading Azure DevOps pull requests…</div>
</div>
<script type="module" src="./app.js"></script>
</body>
</html>`;
}
