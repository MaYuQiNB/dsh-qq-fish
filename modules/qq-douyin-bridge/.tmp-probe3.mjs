import { openPage, sleep } from 'file:///C:/Users/<YOU>/Documents/deepseek-harness/default-workspace/dsh-douyin-scroll/lib/chrome.mjs'
const ids = ['7707018267239533833', '7707562342396988722', '7703058532962806523']
const c = await openPage({ url: 'https://www.douyin.com/' })
try {
  for (const id of ids) {
    await c.send('Page.navigate', { url: `https://www.douyin.com/video/${id}` })
    await sleep(9000)
    const url = String(await c.ev('location.href'))
    const title = String(await c.ev('document.title'))
    const body = String(await c.ev('document.body.innerText.slice(0,300)')).replace(/\s+/g, ' ')
    const hasVideoShare = Number(await c.ev('document.querySelectorAll(\'[data-e2e="video-share-icon-container"]\').length'))
    const hasAnyShare = Number(await c.ev('document.querySelectorAll(\'[data-e2e*="share"]\').length'))
    const loggedOut = /扫码登录|登录后免费|验证码登录/.test(body)
    console.log(JSON.stringify({ id, url, title, hasVideoShare, hasAnyShare, loggedOut, body: body.slice(0, 150) }))
  }
} finally { c.close() }
