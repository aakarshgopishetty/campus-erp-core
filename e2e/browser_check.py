# Optional: pip install playwright; playwright install chromium; start the app on :3000 with a fresh DB; python3 e2e/browser_check.py
from playwright.sync_api import sync_playwright
B='http://localhost:3000'
with sync_playwright() as p:
    br=p.chromium.launch(args=['--no-sandbox'])
    ctx=br.new_context(viewport={'width':390,'height':780}); pg=ctx.new_page()
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    def login(email):
        pg.goto(B); pg.fill('input[type=email]',email); pg.fill('input[type=password]','demo-pass-1'); pg.click('.card .btn'); pg.wait_for_selector('nav button')
    login('faculty@demo.test'); pg.wait_for_selector('.ar'); print('roster rows',pg.locator('.ar').count())
    pg.locator('.ar').nth(1).click(); print('toggled ->',pg.locator('.pill').nth(1).inner_text())
    ctx.set_offline(True); pg.evaluate("dispatchEvent(new Event('offline'))")
    pg.click('text=Save attendance'); pg.wait_for_timeout(600); print('offline header:',pg.inner_text('#net'),'| toast:',pg.inner_text('#toast'))
    ctx.set_offline(False); pg.evaluate("dispatchEvent(new Event('online'))"); pg.wait_for_timeout(1500); print('online header:',pg.inner_text('#net'),'| toast:',pg.inner_text('#toast'))
    pg.screenshot(path='/tmp/att.png')
    pg.click('nav >> text=Marks'); pg.wait_for_selector('input.mk'); i=pg.locator('input.mk').first; i.fill('15'); i.dispatch_event('change'); pg.wait_for_timeout(500); print('marks toast:',pg.inner_text('#toast'))
    pg.click('#out'); login('admin@demo.test')
    pg.click('nav >> text=Marks'); pg.wait_for_selector('text=Lock after moderation'); pg.click('text=Lock after moderation'); pg.wait_for_selector('text=Locked after moderation')
    with pg.expect_download() as d: pg.click('text=Export CSV')
    print('csv bytes',len(open(d.value.path()).read()))
    pg.click('nav >> text=Ask'); pg.fill('input','second-year students below 75%'); pg.click('main .btn'); pg.wait_for_selector('.note',timeout=8000); print('ask:',pg.inner_text('.note').split('\n')[0])
    pg.screenshot(path='/tmp/ask.png'); pg.click('nav >> text=Fees'); pg.wait_for_selector('table'); print('fees rows',pg.locator('tr').count())
    print('JS errors:',errs); br.close()
