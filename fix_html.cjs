const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf-8');

// Replace everything before <p>나만의 스마트 메모 앱<br> with correct head
const startPoint = html.indexOf('<p>나만의 스마트 메모 앱');
if (startPoint > -1) {
  const correctHead = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MyNote</title>
<link rel="icon" type="image/png" href="icon-192.png">
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="theme-color" content="#7BAEC8">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="MyNote">
<meta name="screen-orientation" content="portrait">
<meta name="x5-orientation" content="portrait">
<meta name="browsermode" content="application">
  <link rel="stylesheet" href="/src/style.css">
</head>
<body>
<!-- Loading -->
<div id="loading-screen" style="display: none;">
  <div style="font-size:52px;margin-bottom:16px">📝</div>
  <div class="spinner"></div>
  <p style="color:var(--text-light);font-size:14px">MyNote 불러오는 중...</p>
</div>

<!-- Auth -->
<div id="auth-screen">
  <div class="auth-box">
    <div class="auth-icon">📝</div>
    <h1>MyNote</h1>
    `;
    
  html = correctHead + html.substring(startPoint);
  
  if (!html.includes('<script type="module" src="/src/main.ts"></script>')) {
    html += '\n<script type="module" src="/src/main.ts"></script>\n</body>\n</html>';
  }
  
  fs.writeFileSync('index.html', html);
  console.log('Fixed index.html');
} else {
  console.log('Could not find start point');
}
