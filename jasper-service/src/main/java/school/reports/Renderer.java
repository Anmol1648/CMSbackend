package school.reports;

import net.sf.jasperreports.engine.DefaultJasperReportsContext;
import net.sf.jasperreports.engine.JRField;
import net.sf.jasperreports.engine.JRParameter;
import net.sf.jasperreports.engine.JasperCompileManager;
import net.sf.jasperreports.engine.JasperFillManager;
import net.sf.jasperreports.engine.JasperPrint;
import net.sf.jasperreports.engine.JasperReport;
import net.sf.jasperreports.engine.SimpleJasperReportsContext;
import net.sf.jasperreports.engine.export.ooxml.JRDocxExporter;
import net.sf.jasperreports.engine.export.ooxml.JRXlsxExporter;
import net.sf.jasperreports.export.SimpleExporterInput;
import net.sf.jasperreports.export.SimpleOutputStreamExporterOutput;
import net.sf.jasperreports.export.SimpleXlsxReportConfiguration;
import net.sf.jasperreports.governors.MaxPagesGovernorException;
import net.sf.jasperreports.governors.TimeoutGovernorException;
import net.sf.jasperreports.pdf.JRPdfExporter;
import net.sf.jasperreports.pdf.SimplePdfExporterConfiguration;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/** Compiles designs (kept compiled, by content), fills them with rows and exports the result. */
final class Renderer {
    static final String VERSION = "7.0.3";
    private static final int MAX_ROWS = 200_000;
    static final Locale INDIA = Locale.forLanguageTag("en-IN");
    static final TimeZone IST = TimeZone.getTimeZone("Asia/Kolkata");

    record Output(byte[] bytes, String contentType, int pages) {}

    private final SimpleJasperReportsContext context;
    private final Map<String, JasperReport> compiled = Collections.synchronizedMap(new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, JasperReport> eldest) {
            return size() > 64;
        }
    });

    Renderer(int maxPages, int timeoutSeconds) {
        context = new SimpleJasperReportsContext(DefaultJasperReportsContext.getInstance());
        // Limits, so one report can't take the service down.
        context.setProperty("net.sf.jasperreports.governor.max.pages.enabled", "true");
        context.setProperty("net.sf.jasperreports.governor.max.pages", String.valueOf(maxPages));
        context.setProperty("net.sf.jasperreports.governor.timeout.enabled", "true");
        context.setProperty("net.sf.jasperreports.governor.timeout", String.valueOf(timeoutSeconds * 1000L));
        // Our fonts (English + ₹ + Hindi) unless a design says otherwise.
        context.setProperty("net.sf.jasperreports.default.font.name", "School");
        context.setProperty("net.sf.jasperreports.awt.ignore.missing.font", "false");
        // Excel: one header at the top, no page footers in between the rows, numbers as numbers.
        context.setProperty("net.sf.jasperreports.export.xls.exclude.origin.keep.first.band.1", "pageHeader");
        context.setProperty("net.sf.jasperreports.export.xls.exclude.origin.keep.first.band.2", "columnHeader");
        context.setProperty("net.sf.jasperreports.export.xls.exclude.origin.band.3", "pageFooter");
        context.setProperty("net.sf.jasperreports.export.xls.exclude.origin.band.4", "lastPageFooter");
        context.setProperty("net.sf.jasperreports.export.xls.detect.cell.type", "true");
    }

    JasperReport compile(String design) {
        String key = sha256(design);
        JasperReport report = compiled.get(key);
        if (report != null) return report;
        try {
            report = JasperCompileManager.getInstance(context).compile(new ByteArrayInputStream(design.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new ReportException(400, "design", "The report design has a mistake", clean(e));
        }
        compiled.put(key, report);
        return report;
    }

    /** What a design expects: its fields (one per column of data) and parameters (single values). */
    Map<String, Object> inspect(String design) {
        JasperReport r = compile(design);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", r.getName());
        out.put("pageWidth", r.getPageWidth());
        out.put("pageHeight", r.getPageHeight());
        out.put("orientation", r.getOrientation() == null ? null : r.getOrientation().name().toLowerCase(Locale.ROOT));
        List<Map<String, Object>> fields = new ArrayList<>();
        if (r.getFields() != null) for (JRField f : r.getFields()) fields.add(describe(f.getName(), f.getValueClassName(), f.getDescription()));
        out.put("fields", fields);
        List<Map<String, Object>> params = new ArrayList<>();
        if (r.getParameters() != null) for (JRParameter p : r.getParameters()) if (!p.isSystemDefined()) params.add(describe(p.getName(), p.getValueClassName(), p.getDescription()));
        out.put("parameters", params);
        return out;
    }

    Output render(String design, String format, List<Map<String, Object>> rows, Map<String, Object> params) {
        JasperReport report = compile(design);
        if (rows != null && rows.size() > MAX_ROWS) throw new ReportException(413, "limit", "Too many rows for one report (" + rows.size() + ", at most " + MAX_ROWS + ")", null);

        Map<String, Object> values = new HashMap<>();
        values.put(JRParameter.REPORT_LOCALE, INDIA);
        values.put(JRParameter.REPORT_TIME_ZONE, IST);
        values.put(JRParameter.REPORT_FORMAT_FACTORY, new IndianFormatFactory());
        if (params != null && report.getParameters() != null) {
            for (JRParameter p : report.getParameters()) {
                if (p.isSystemDefined() || !params.containsKey(p.getName())) continue;
                values.put(p.getName(), Values.coerce(params.get(p.getName()), p.getValueClass(), "parameter " + p.getName()));
            }
        }

        JasperPrint print;
        try {
            print = JasperFillManager.getInstance(context).fill(report, values, new RowsDataSource(rows == null ? List.of() : rows));
        } catch (ReportException e) {
            throw e;
        } catch (Exception e) {
            Throwable root = rootCause(e);
            if (root instanceof MaxPagesGovernorException) throw new ReportException(422, "limit", "The report has too many pages: choose fewer records (a shorter period, one class)", null);
            if (root instanceof TimeoutGovernorException) throw new ReportException(422, "limit", "The report took too long: choose fewer records", null);
            if (root instanceof ReportException re) throw re;
            throw new ReportException(422, "data", "The report could not be filled with the data", clean(e));
        }

        ByteArrayOutputStream bytes = new ByteArrayOutputStream(64 * 1024);
        try {
            switch (format) {
                case "pdf" -> {
                    JRPdfExporter x = new JRPdfExporter(context);
                    x.setExporterInput(new SimpleExporterInput(print));
                    x.setExporterOutput(new SimpleOutputStreamExporterOutput(bytes));
                    SimplePdfExporterConfiguration c = new SimplePdfExporterConfiguration();
                    c.setMetadataTitle(print.getName());
                    c.setMetadataCreator("School ERP");
                    x.setConfiguration(c);
                    x.exportReport();
                    return new Output(bytes.toByteArray(), "application/pdf", print.getPages().size());
                }
                case "xlsx" -> {
                    JRXlsxExporter x = new JRXlsxExporter(context);
                    x.setExporterInput(new SimpleExporterInput(print));
                    x.setExporterOutput(new SimpleOutputStreamExporterOutput(bytes));
                    SimpleXlsxReportConfiguration c = new SimpleXlsxReportConfiguration();
                    c.setOnePagePerSheet(false);
                    c.setRemoveEmptySpaceBetweenRows(true);
                    c.setRemoveEmptySpaceBetweenColumns(true);
                    c.setDetectCellType(true);
                    c.setWhitePageBackground(false);
                    c.setCollapseRowSpan(true);
                    x.setConfiguration(c);
                    x.exportReport();
                    return new Output(bytes.toByteArray(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", print.getPages().size());
                }
                case "docx" -> {
                    JRDocxExporter x = new JRDocxExporter(context);
                    x.setExporterInput(new SimpleExporterInput(print));
                    x.setExporterOutput(new SimpleOutputStreamExporterOutput(bytes));
                    x.exportReport();
                    return new Output(bytes.toByteArray(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", print.getPages().size());
                }
                default -> throw new ReportException(400, "data", "Unknown format \"" + format + "\" (pdf, xlsx or docx)", null);
            }
        } catch (ReportException e) {
            throw e;
        } catch (Exception e) {
            throw new ReportException(500, "internal", "The report could not be exported", clean(e));
        }
    }

    private static Map<String, Object> describe(String name, String type, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("type", type);
        if (description != null && !description.isBlank()) m.put("description", description);
        return m;
    }

    private static Throwable rootCause(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null && r.getCause() != r) r = r.getCause();
        return r;
    }

    /** The useful part of an error: its message (and its causes'), without Java stack noise. */
    private static String clean(Throwable e) {
        StringBuilder sb = new StringBuilder();
        Throwable t = e;
        int depth = 0;
        while (t != null && depth++ < 4) {
            String m = t.getMessage();
            if (m != null && !m.isBlank() && sb.indexOf(m) < 0) {
                if (sb.length() > 0) sb.append("\n");
                sb.append(m.trim());
            }
            t = t.getCause() == t ? null : t.getCause();
        }
        String s = sb.length() == 0 ? e.getClass().getSimpleName() : sb.toString();
        return s.length() > 4000 ? s.substring(0, 4000) + "…" : s;
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
