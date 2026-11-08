/**
 * The page of `/` of `workflows web`: the control center, with the inspect view of harness. It has the class
 * `inspect-page` of harness inspect, for the colors and the font of its theme.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workflows web</title>
<link rel="stylesheet" href="/assets/inspect.css">
<link rel="stylesheet" href="/assets/control.css">
</head>
<body class="inspect-page">
<main id="control"></main>
<script type="module">
import { mountControl } from "/assets/control.js";
mountControl(document.getElementById("control"));
</script>
</body>
</html>
`;
