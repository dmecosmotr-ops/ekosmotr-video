"""Create only synthetic microphone material in the ignored local preview directory."""

import json
import os
from pathlib import Path

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parent.parent / 'private' / 'microphones-localhost'
DATE = '2026-10-14'
PRODUCTS = ('first_aid_kit', 'fire_extinguisher', 'warning_triangle', 'license_plate_frames')
STATIONS = [
    dict(id='demo-mic-pto-1', region='Учебный регион А', city='Учебный город', address='ул. Примерная, 1'),
    dict(id='demo-mic-pto-2', region='Учебный регион А', city='Учебный город', address='ул. Примерная, 2'),
    dict(id='demo-mic-pto-3', region='Учебный регион Б', city='Демо-город', address='ул. Тестовая, 3'),
]


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def make_pdf(path, station, offer):
    pdf = Canvas(str(path), pagesize=A4, pageCompression=1)
    pdf.setTitle('Микрофоны — учебный отчёт по смене')
    pdf.setAuthor('Экосмотр • локальная демонстрация')
    width, height = A4
    ink, muted, accent = map(HexColor, ('#132238', '#485d75', '#165c53'))

    def label(x, y, value, size=12, bold=False, color=ink):
        pdf.setFillColor(color)
        pdf.setFont('DemoBold' if bold else 'DemoRegular', size)
        pdf.drawString(x, y, value)

    def page(title, number):
        pdf.setFillColor(accent)
        pdf.rect(0, height - 54, width, 54, fill=1, stroke=0)
        label(42, height - 32, 'ЭКОСМОТР   /   МИКРОФОНЫ   /   УЧЕБНЫЕ ДАННЫЕ', 11, True, white)
        label(42, height - 99, title, 25, True)
        label(42, height - 123, f'14.10.2026  ·  {station["city"]}, {station["address"]}', 12, False, muted)
        label(42, 42, f'{number} / 3   ·   Пример интерфейса. Данные вымышлены.', 10, False, muted)

    page('Итоги смены', 1)
    label(42, 667, 'Предложения доптоваров', 13, True)
    label(42, 625, '2 эпизода' if offer else '0 эпизодов', 30, True, accent)
    label(312, 667, 'Подтверждённые продажи', 13, True)
    label(312, 629, 'Нет данных', 24, True)
    label(42, 573, 'Доптовары', 17, True)
    for index, product in enumerate(('Аптечка', 'Огнетушитель', 'Знак аварийной остановки', 'Рамки номеров')):
        y = 535 - 32 * index
        label(42, y, product)
        label(385, y, '1 предложение' if offer and index < 2 else '0 предложений', color=muted)
    label(42, 366, 'Как читать цифры', 13, True)
    label(42, 341, 'Предложения считаются по эпизодам. Эпизод не равен визиту.')
    label(42, 318, 'Согласие купить не подтверждает оплату.')
    label(42, 262, 'Перейти к ключевым разговорам →', 12, True, accent)
    pdf.linkRect('Ключевые разговоры', 'conversations', (42, 257, 277, 277), relative=0)
    pdf.showPage()

    conversations = [
        ('00:12:40–00:12:54', 'Аптечка', ['Эксперт: Аптечка у вас есть? У нас можно купить.',
                                          'Клиент: Да, возьму.']),
        ('00:27:10–00:27:26', 'Огнетушитель', ['Эксперт: Если нужен огнетушитель, есть в продаже.',
                                              'Клиент: Спасибо, свой есть.']),
    ] if offer else [
        ('00:18:05–00:18:19', 'Оформление визита', ['Клиент: Куда мне подъехать?',
                                                   'Эксперт: Подъезжайте к воротам, я покажу.']),
    ]
    page('Ключевые разговоры', 2)
    pdf.bookmarkPage('conversations')
    for index, (time, subject, lines) in enumerate(conversations):
        y = 655 - 131 * index
        label(42, y, f'{time}   ·   {subject}', 13, True, accent)
        pdf.linkRect('К расшифровке эпизода', f'episode-{index + 1}', (42, y - 5, 300, y + 15), relative=0)
        for offset, line in enumerate(lines, 1):
            label(42, y - 22 * offset, line)
    pdf.showPage()

    page('Расшифровка по эпизодам', 3)
    for index, (time, _, lines) in enumerate(conversations, 1):
        y = 752 - 100 * index
        pdf.bookmarkHorizontalAbsolute(f'episode-{index}', y + 32, left=42)
        label(42, y, f'Эпизод {index}  /  {time}', 13, True)
        for offset, line in enumerate(lines, 1):
            label(42, y - 22 * offset, line)
    pdf.save()


def main():
    fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' if os.name == 'nt' else Path('/usr/share/fonts/truetype/dejavu')
    regular, bold = ('arial.ttf', 'arialbd.ttf') if os.name == 'nt' else ('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf')
    pdfmetrics.registerFont(TTFont('DemoRegular', str(fonts / regular)))
    pdfmetrics.registerFont(TTFont('DemoBold', str(fonts / bold)))
    reports = ROOT / 'reports'
    reports.mkdir(parents=True, exist_ok=True)
    write_json(ROOT / 'stations.json', STATIONS)

    def ready(index, date, offers):
        name = f'example-{index}.pdf'
        make_pdf(reports / name, STATIONS[index - 1], bool(offers))
        return dict(id=f'demo-shift-{index}', stationId=STATIONS[index - 1]['id'], date=date,
                    status='ready', pdf=name, demo=True,
                    metrics=dict(offerEpisodes=offers, sales=None,
                                 products={key: dict(offerEpisodes=int(bool(offers) and i < 2), sales=None)
                                           for i, key in enumerate(PRODUCTS)}))

    shifts = [ready(1, DATE, 2), ready(2, DATE, 0),
              dict(id='demo-shift-3', stationId=STATIONS[2]['id'], date=DATE, status='processing', demo=True),
              dict(id='demo-shift-4', stationId=STATIONS[2]['id'], date=DATE, status='missing', demo=True)]
    # Separate statuses on one date are valid: each record represents its own shift.
    write_json(reports / 'catalog.json', dict(version=1, shifts=shifts))


if __name__ == '__main__':
    main()
