import json
import os
from pathlib import Path
import re
import subprocess
import time
from xml.etree import ElementTree

serial = ['adb', '-s', 'emulator-5560']
directory = Path('acceptance')
package = 'network.awai.itonami.market'
cid = os.environ['EXPECTED_MARKET_CID']


def adb(*args):
    return subprocess.check_output(serial + list(args), timeout=35)


def dump():
    path = '/sdcard/market.xml'
    try:
        adb('shell', 'uiautomator', 'dump', path)
        xml = adb('exec-out', 'cat', path)
        return xml, list(ElementTree.fromstring(xml).iter('node'))
    except (subprocess.SubprocessError, ElementTree.ParseError):
        return b'', []


def locate(text, scroll=False):
    for _ in range(22):
        xml, entries = dump()
        matches = [node for node in entries if text in node.get('text', '')]
        if matches:
            return xml, entries, matches[0]
        if scroll and entries:
            adb('shell', 'input', 'swipe', '520', '950', '520', '520', '450')
        time.sleep(.7)
    raise AssertionError(f'Android UI text missing: {text}')


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    assert x2 > x1 and y2 > y1
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def approve(operation, bound_value):
    _, nodes, prompt = locate(operation)
    assert bound_value in prompt.get('text')
    tap(next(node for node in nodes if node.get('text') == 'Allow once'))


assert adb('shell', 'getprop', 'ro.build.version.sdk').strip() == b'35'
adb('shell', 'wm', 'size', '1080x2000')
adb('shell', 'wm', 'density', '280')
adb('shell', 'input', 'keyevent', '82')
assert b'Success' in adb('install', str(directory/'itonami-market-x86_64-debug.apk'))
adb('shell', 'am', 'start', '-W', '-n', package + '/.MainActivity')
tap(locate('最新スナップショットを取得')[2])
approve('read-latest-market-cid', '/latest-v2.json')
approve('read-market-block', cid)
locate('最新の公開スナップショットを表示')
supply_xml, supply_nodes, _ = locate('流通供給量と時価総額', scroll=True)
supply_text = [node.get('text', '') for node in supply_nodes]
while supply_text.count('欠損') < 4:
    adb('shell', 'input', 'swipe', '520', '940', '520', '760', '500')
    supply_xml, supply_nodes = dump()
    supply_text = [node.get('text', '') for node in supply_nodes]
    if supply_text.count('欠損') == 4:
        break
    assert '流通供給量と時価総額' in supply_text, supply_text
assert 'WETH' in supply_text and 'WBTC' in supply_text, supply_text
(directory/'android-supply.xml').write_bytes(supply_xml)
(directory/'android-supply.png').write_bytes(adb('exec-out', 'screencap', '-p'))
verified_xml, _, verified_node = locate('CID 検証済み', scroll=True)
assert cid in verified_node.get('text')
(directory/'android-cid.xml').write_bytes(verified_xml)
(directory/'android-cid.png').write_bytes(adb('exec-out', 'screencap', '-p'))
print(json.dumps({'device':'Android 15 API 35 x86_64 emulator', 'cid':cid,
                  'missingCells':supply_text.count('欠損'), 'verified':True}))
