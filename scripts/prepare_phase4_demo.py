"""Generate labelled synthetic PDFs locally. No cloud access or account creation.

Optional authoring dependencies: reportlab and pypdfium2, installed into the
Git-ignored .nampol/phase4-tools directory, not application requirements.
"""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    sys.path.insert(0, str(ROOT / '.nampol/phase4-tools'))
    from reportlab.pdfgen import canvas
    from reportlab.lib.colors import HexColor
    from pypdf import PdfReader, PdfWriter
    import pypdfium2 as pdfium
    from PIL import Image, ImageDraw

    output = ROOT / 'output/pdf/phase4-demo'
    output.mkdir(parents=True, exist_ok=True)
    previews = ROOT / 'tmp/pdfs/phase4'
    previews.mkdir(parents=True, exist_ok=True)
    docs = {
        'alpha-cv': ('Curriculum vitae', 'Demo Applicant Alpha', [
            ('CONTACT', 'phase2-test-alpha@example.invalid | Khomas, Namibia'),
            ('PROFILE', 'Community support volunteer with practical public-service training.'),
            ('SKILLS', 'Computer literacy: spreadsheets, reports and secure record keeping.'),
            ('TRAINING', 'First aid: supervised emergency response exercises.'),
            ('EXPERIENCE', '2023-2025: community liaison and incident reporting, Fictional Civic Club.'),
            ('EDUCATION', 'Diploma in Policing, Fictional Academic Training Centre, 2022.'),
            ('RESEARCH NOTE', 'All names, dates, roles and institutions on this page are invented.')]),
        'alpha-qualification': ('Qualification specimen', 'Demo Applicant Alpha', [
            ('FICTIONAL ISSUER', 'Fictional Academic Training Centre'),
            ('EDUCATION RECORD', 'Diploma in Policing | Completion year: 2022'),
            ('SUBJECTS', 'Community relations, incident reporting and public-service ethics.'),
            ('RECORD REFERENCE', 'SYNTHETIC-ALPHA-QUAL-001'),
            ('LIMITATION', 'This invented record is not an accredited award or proof of authenticity.')]),
        'alpha-identification': ('Identity specimen', 'Demo Applicant Alpha', [
            ('SPECIMEN REFERENCE', 'DEMO-ALPHA001'),
            ('INVENTED DATE OF BIRTH', '12 March 1999'),
            ('RESEARCH REGION', 'Khomas, Namibia'),
            ('LIMITATION', 'Not a valid identity document. No government issuer, seal or real ID number.')]),
        'beta-cv': ('Curriculum vitae', 'Demo Applicant Beta', [
            ('CONTACT', 'phase2-test-beta@example.invalid | Khomas, Namibia'),
            ('PROFILE', 'Office support candidate with customer service experience.'),
            ('SKILLS', 'Visitor reception, appointment scheduling and paper filing.'),
            ('EXPERIENCE', '2024-2025: office assistant, Fictional Community Office.'),
            ('EDUCATION', 'Certificate in Administration, Fictional Learning Centre, 2023.'),
            ('RESEARCH NOTE', 'All names, dates, roles and institutions on this page are invented.')]),
        'beta-qualification': ('Qualification specimen', 'Demo Applicant Beta', [
            ('FICTIONAL ISSUER', 'Fictional Learning Centre'),
            ('EDUCATION RECORD', 'Certificate in Administration | Completion year: 2023'),
            ('SUBJECTS', 'Office procedures, correspondence and customer service.'),
            ('RECORD REFERENCE', 'SYNTHETIC-BETA-QUAL-001'),
            ('LIMITATION', 'This invented record is not an accredited award or proof of authenticity.')]),
        'beta-identification': ('Identity specimen', 'Demo Applicant Beta', [
            ('SPECIMEN REFERENCE', 'DEMO-BETA0001'),
            ('INVENTED DATE OF BIRTH', '8 July 2000'),
            ('RESEARCH REGION', 'Khomas, Namibia'),
            ('LIMITATION', 'Not a valid identity document. No government issuer, seal or real ID number.')])
    }
    entries, tiles = [], []
    combined = PdfWriter()
    for name, (title, person, sections) in docs.items():
        path = output / (name + '.pdf')
        pdf = canvas.Canvas(str(path), pagesize=(595.28, 841.89), invariant=1)
        pdf.setTitle(f'SYNTHETIC ACADEMIC DEMO - {person} - {title}')
        pdf.setAuthor('NamPol academic prototype - synthetic fixtures')
        pdf.setFillColor(HexColor('#102c46')); pdf.rect(0, 716, 596, 126, fill=1, stroke=0)
        pdf.setFillColor(HexColor('#ffffff')); pdf.setFont('Helvetica-Bold', 11)
        pdf.drawString(44, 802, 'SYNTHETIC ACADEMIC DEMONSTRATION')
        pdf.setFont('Helvetica-Bold', 25); pdf.drawString(44, 762, title)
        pdf.setFillColor(HexColor('#102c46')); pdf.setFont('Helvetica-Bold', 20)
        pdf.drawString(44, 677, person)
        y = 630
        for heading, content in sections:
            pdf.setFillColor(HexColor('#38627d')); pdf.setFont('Helvetica-Bold', 10)
            pdf.drawString(44, y, heading); y -= 20
            pdf.setFillColor(HexColor('#243747')); pdf.setFont('Helvetica', 10)
            # Deliberately short lines: no clipping and text remains extractable.
            import textwrap
            for line in textwrap.wrap(content, width=92):
                pdf.drawString(44, y, line); y -= 16
            y -= 21
        pdf.setStrokeColor(HexColor('#bccbd5')); pdf.line(44, 65, 551, 65)
        pdf.setFillColor(HexColor('#38627d')); pdf.setFont('Helvetica', 9)
        pdf.drawString(44, 46, 'SYNTHETIC ONLY | NOT VALID FOR EMPLOYMENT OR IDENTITY VERIFICATION')
        pdf.drawString(44, 32, 'Academic research sample - no genuine applicant information')
        pdf.showPage(); pdf.save()
        reader = PdfReader(path)
        assert len(reader.pages) == 1 and 'SYNTHETIC' in reader.pages[0].extract_text()
        combined.add_page(reader.pages[0])
        raw = path.read_bytes()
        entries.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': len(raw),
                        'sha256': hashlib.sha256(raw).hexdigest(), 'pages': 1, 'synthetic': True})
        doc = pdfium.PdfDocument(str(path)); page = doc[0]
        rendered = page.render(scale=1).to_pil(); rendered.save(previews / (name + '.png'))
        rendered.thumbnail((298, 421))
        tile = Image.new('RGB', (318, 455), 'white'); tile.paste(rendered, (10, 25))
        ImageDraw.Draw(tile).text((10, 7), name, fill='black'); tiles.append(tile)
        page.close(); doc.close()
    pack = ROOT / 'output/pdf/phase4-demo-pack.pdf'
    with pack.open('wb') as stream: combined.write(stream)
    combined.close()
    sheet = Image.new('RGB', (954, 910), '#d9e2e8')
    for i, tile in enumerate(tiles): sheet.paste(tile, ((i % 3) * 318, (i // 3) * 455))
    sheet.save(previews / 'contact-sheet.png')
    (output / 'manifest.json').write_text(json.dumps({'label': 'SYNTHETIC ONLY', 'documents': entries}, indent=2) + '\n', encoding='utf-8')
    print('Prepared six synthetic upload PDFs and one six-page review pack. No accounts or cloud records changed.')


if __name__ == '__main__': main()
