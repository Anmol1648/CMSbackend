import { COMMON_PARAMETERS, GROUP_FIELDS, ReportColumn, ReportDef } from './reports.registry';

/**
 * A Jasper design (JasperReports 7 .jrxml) made from a report's columns: the school's letterhead,
 * the table with a heading row on every page, group headings and subtotals, the grand total and page
 * numbers. A starting point to open in Jaspersoft Studio and make the school's own.
 */

const PAGE = { portrait: { w: 595, h: 842, col: 539 }, landscape: { w: 842, h: 595, col: 786 } };
const CLASS: Record<ReportColumn['type'], string> = { text: 'java.lang.String', number: 'java.math.BigDecimal', money: 'java.math.BigDecimal', date: 'java.util.Date' };
const PATTERN: Partial<Record<ReportColumn['type'], string>> = { money: '₹ #,##,##0', number: '#,##,##0', date: 'dd MMM yyyy' };

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const right = (c: ReportColumn) => c.type === 'money' || c.type === 'number';
const pad = (c: ReportColumn) => (right(c) ? 'rightPadding="4"' : 'leftPadding="4"');

/** Widths in points that add up exactly to the column width. */
const layout = (columns: ReportColumn[], total: number) => {
    const weight = columns.reduce((a, c) => a + (c.width ?? 1), 0);
    let x = 0;
    return columns.map((c, i) => {
        const w = i === columns.length - 1 ? total - x : Math.round(((c.width ?? 1) / weight) * total);
        const at = { c, x, w };
        x += w;
        return at;
    });
};

export const generateJrxml = (def: ReportDef) => {
    const page = PAGE[def.orientation];
    const cols = layout(def.columns, page.col);
    const totals = cols.filter((x) => x.c.total);
    const firstTotal = totals.length ? totals[0].x : page.col;
    const name = def.key.replace(/[^A-Za-z0-9_]/g, '_');

    const parameters = COMMON_PARAMETERS.map((p) => `\t<parameter name="${p.name}" class="${p.type}">\n\t\t<description>${cdata(p.description)}</description>\n\t</parameter>`).join('\n');
    const fields = [...def.columns, ...GROUP_FIELDS].map((c) => `\t<field name="${c.key}" class="${CLASS[c.type]}">\n\t\t<description>${cdata(c.label)}</description>\n\t</field>`).join('\n');
    const variables = totals
        .map(
            ({ c }) =>
                `\t<variable name="group_${c.key}" resetType="Group" calculation="Sum" resetGroup="grp" class="java.math.BigDecimal">\n\t\t<expression>${cdata(`$F{${c.key}}`)}</expression>\n\t</variable>\n` +
                `\t<variable name="total_${c.key}" calculation="Sum" class="java.math.BigDecimal">\n\t\t<expression>${cdata(`$F{${c.key}}`)}</expression>\n\t</variable>`
        )
        .join('\n');

    const sumCells = (prefix: string, label: string, y: number, h: number, box: string, size = '') =>
        [
            // (No label cell when the very first column is added up.)
            firstTotal === 0 ? null : `\t\t\t\t<element kind="textField" x="0" y="${y}" width="${firstTotal}" height="${h}" bold="true"${size}>\n\t\t\t\t\t<expression>${cdata(label)}</expression>\n\t\t\t\t\t<box leftPadding="4">${box}</box>\n\t\t\t\t</element>`,
            ...cols
                .filter(({ x }) => x >= firstTotal)
                .map(({ c, x, w }) =>
                    c.total
                        ? `\t\t\t\t<element kind="textField" x="${x}" y="${y}" width="${w}" height="${h}" bold="true"${size} pattern="${PATTERN[c.type] ?? '#,##,##0'}" hTextAlign="Right">\n\t\t\t\t\t<expression>${cdata(`$V{${prefix}_${c.key}}`)}</expression>\n\t\t\t\t\t<box rightPadding="4">${box}</box>\n\t\t\t\t</element>`
                        : `\t\t\t\t<element kind="staticText" x="${x}" y="${y}" width="${w}" height="${h}"><text>${cdata('')}</text><box>${box}</box></element>`
                ),
        ]
            .filter(Boolean)
            .join('\n');

    const grouped = '$P{GROUPED_BY} != null && !$P{GROUPED_BY}.isEmpty()';
    const groupLine = '<bottomPen lineWidth="0.75" lineColor="#999999"/>';
    const totalLine = '<topPen lineWidth="1.5" lineColor="#1A365D"/><bottomPen lineWidth="1.5" lineColor="#1A365D"/>';
    const count = (v: string) => `" · " + ${v} + (${v} == 1 ? " row" : " rows")`;

    const head = cols
        .map(({ c, x, w }) => `\t\t<element kind="staticText" x="${x}" y="2" width="${w}" height="18" forecolor="#FFFFFF" bold="true"${right(c) ? ' hTextAlign="Right"' : ''}><text>${cdata(c.label)}</text><box ${pad(c)}/></element>`)
        .join('\n');
    const detail = cols
        .map(
            ({ c, x, w }) =>
                `\t\t\t<element kind="textField" stretchType="ContainerHeight" x="${x}" y="0" width="${w}" height="15"${c.type === 'text' ? ' textAdjust="StretchHeight"' : ''}${PATTERN[c.type] ? ` pattern="${PATTERN[c.type]}"` : ''}${right(c) ? ' hTextAlign="Right"' : ''} blankWhenNull="true"><expression>${cdata(`$F{${c.key}}`)}</expression><box ${pad(c)}><bottomPen lineWidth="0.5" lineColor="#DDDDDD"/></box></element>`
        )
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${attr(def.label)}: a design made by the ERP from the report's columns (JasperReports 7).
  Open it in Jaspersoft Studio 7, change it, then upload it in Report Center → ${attr(def.label)} → Design.
  Use the font "School" for Hindi and the ₹ sign; amounts in lakhs / crores: pattern "₹ #,##,##0".
-->
<jasperReport name="${name}" language="java" pageWidth="${page.w}" pageHeight="${page.h}"${def.orientation === 'landscape' ? ' orientation="Landscape"' : ''} whenNoDataType="NoDataSection" columnWidth="${page.col}" leftMargin="28" rightMargin="28" topMargin="24" bottomMargin="24">
\t<style name="Base" default="true" fontName="School" fontSize="8.0" vTextAlign="Middle"/>
${parameters}
${fields}
${variables}
\t<variable name="groupCount" resetType="Group" calculation="Count" resetGroup="grp" class="java.lang.Integer">
\t\t<expression>${cdata('1')}</expression>
\t</variable>
\t<group name="grp" minHeightToStartNewPage="40">
\t\t<expression>${cdata('$F{groupKey}')}</expression>
\t\t<groupHeader>
\t\t\t<band height="18" splitType="Prevent">
\t\t\t\t<printWhenExpression>${cdata(grouped)}</printWhenExpression>
\t\t\t\t<element kind="textField" mode="Opaque" x="0" y="2" width="${page.col}" height="16" forecolor="#1A365D" backcolor="#EEF2F7" bold="true" fontSize="8.5">
\t\t\t\t\t<expression>${cdata('$P{GROUPED_BY} + ": " + $F{groupLabel}')}</expression>
\t\t\t\t\t<box leftPadding="4"><bottomPen lineWidth="0.75" lineColor="#C9D3E0"/></box>
\t\t\t\t</element>
\t\t\t</band>
\t\t</groupHeader>
\t\t<groupFooter>
\t\t\t<band height="17" splitType="Prevent">
\t\t\t\t<printWhenExpression>${cdata(grouped)}</printWhenExpression>
${sumCells('group', `"Total for " + $F{groupLabel} + ${count('$V{groupCount}')}`, 0, 15, groupLine)}
\t\t\t</band>
\t\t</groupFooter>
\t</group>
\t<title height="90" splitType="Prevent">
\t\t<element kind="image" x="0" y="0" width="48" height="48" scaleImage="RetainShape" hImageAlign="Center" vImageAlign="Middle">
\t\t\t<printWhenExpression>${cdata('$P{SCHOOL_LOGO} != null')}</printWhenExpression>
\t\t\t<expression>${cdata('$P{SCHOOL_LOGO}')}</expression>
\t\t</element>
\t\t<element kind="textField" x="56" y="0" width="${page.col - 56}" height="22" forecolor="#1A365D" bold="true" fontSize="13.0" blankWhenNull="true">
\t\t\t<expression>${cdata('$P{SCHOOL_NAME} == null ? "" : $P{SCHOOL_NAME}.toUpperCase()')}</expression>
\t\t</element>
\t\t<element kind="textField" x="56" y="22" width="${page.col - 56}" height="13" forecolor="#444444" fontSize="8.0" blankWhenNull="true">
\t\t\t<expression>${cdata('$P{SCHOOL_ADDRESS}')}</expression>
\t\t</element>
\t\t<element kind="textField" x="56" y="35" width="${page.col - 56}" height="12" forecolor="#444444" fontSize="7.5" blankWhenNull="true">
\t\t\t<expression>${cdata('$P{SCHOOL_CONTACT} + ($P{SCHOOL_CODES} == null || $P{SCHOOL_CODES}.isEmpty() ? "" : "   ·   " + $P{SCHOOL_CODES})')}</expression>
\t\t</element>
\t\t<element kind="line" x="0" y="53" width="${page.col}" height="1" forecolor="#1A365D">
\t\t\t<pen lineWidth="1.5"/>
\t\t</element>
\t\t<element kind="textField" x="0" y="58" width="${page.col}" height="18" bold="true" fontSize="11.0">
\t\t\t<expression>${cdata('$P{REPORT_TITLE}')}</expression>
\t\t</element>
\t\t<element kind="textField" x="0" y="76" width="${page.col}" height="13" forecolor="#555555" fontSize="7.5" blankWhenNull="true">
\t\t\t<expression>${cdata('$P{REPORT_SUBTITLE}')}</expression>
\t\t</element>
\t</title>
\t<columnHeader height="20">
\t\t<element kind="rectangle" mode="Opaque" x="0" y="2" width="${page.col}" height="18" forecolor="#1A365D" backcolor="#1A365D"/>
${head}
\t</columnHeader>
\t<detail>
\t\t<band height="15">
${detail}
\t\t</band>
\t</detail>
\t<pageFooter height="18">
\t\t<element kind="textField" x="0" y="6" width="${page.col - 186}" height="12" forecolor="#666666" fontSize="7.0">
\t\t\t<expression>${cdata('"Printed by " + $P{PRINTED_BY} + " on " + $P{PRINTED_AT}')}</expression>
\t\t</element>
\t\t<element kind="textField" x="${page.col - 186}" y="6" width="160" height="12" forecolor="#666666" fontSize="7.0" hTextAlign="Right">
\t\t\t<expression>${cdata('"Page " + $V{PAGE_NUMBER} + " of"')}</expression>
\t\t</element>
\t\t<element kind="textField" x="${page.col - 26}" y="6" width="26" height="12" forecolor="#666666" fontSize="7.0" evaluationTime="Report">
\t\t\t<expression>${cdata('$V{PAGE_NUMBER}')}</expression>
\t\t\t<box leftPadding="2"/>
\t\t</element>
\t</pageFooter>
\t<summary height="24" splitType="Prevent">
${sumCells('total', `"Grand total" + ${count('$V{REPORT_COUNT}')}`, 6, 18, totalLine, ' fontSize="9.0"').replace(/\t\t\t\t/g, '\t\t')}
\t</summary>
\t<noData height="120">
\t\t<element kind="textField" x="0" y="0" width="${page.col}" height="22" forecolor="#1A365D" bold="true" fontSize="13.0" blankWhenNull="true">
\t\t\t<expression>${cdata('$P{SCHOOL_NAME}')}</expression>
\t\t</element>
\t\t<element kind="textField" x="0" y="26" width="${page.col}" height="18" bold="true" fontSize="11.0">
\t\t\t<expression>${cdata('$P{REPORT_TITLE}')}</expression>
\t\t</element>
\t\t<element kind="textField" x="0" y="44" width="${page.col}" height="13" forecolor="#555555" blankWhenNull="true">
\t\t\t<expression>${cdata('$P{REPORT_SUBTITLE}')}</expression>
\t\t</element>
\t\t<element kind="staticText" x="0" y="70" width="${page.col}" height="20" forecolor="#777777" hTextAlign="Center" fontSize="10.0">
\t\t\t<text>${cdata('Nothing to show for these filters.')}</text>
\t\t</element>
\t</noData>
</jasperReport>
`;
};
