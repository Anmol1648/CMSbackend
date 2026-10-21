package school.reports;

import net.sf.jasperreports.engine.JRDataSource;

import javax.imageio.ImageIO;
import java.awt.Image;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Base64;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.Map;

/**
 * JSON values (text, numbers, true/false, lists) turned into what a design declares: money as
 * BigDecimal, "2026-04-15" as a date, a base64 image as an image or stream, a list of rows as a data
 * source (for sub-reports and tables).
 */
final class Values {
    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private Values() {}

    @SuppressWarnings("unchecked")
    static Object coerce(Object v, Class<?> type, String what) {
        if (v == null || type == null || type == Object.class || type.isInstance(v)) return v;
        try {
            if (type == String.class) return String.valueOf(v);
            if (Number.class.isAssignableFrom(type)) {
                BigDecimal n = v instanceof Number num ? new BigDecimal(num.toString()) : new BigDecimal(String.valueOf(v).trim());
                if (type == BigDecimal.class) return n;
                if (type == Double.class) return n.doubleValue();
                if (type == Integer.class) return n.intValue();
                if (type == Long.class) return n.longValue();
                if (type == Float.class) return n.floatValue();
                if (type == Short.class) return n.shortValue();
                if (type == BigInteger.class) return n.toBigInteger();
                if (type == Number.class) return n;
            }
            if (type == Boolean.class) return v instanceof Boolean ? v : Boolean.valueOf(String.valueOf(v));
            if (type == LocalDate.class) return LocalDate.parse(String.valueOf(v).substring(0, 10));
            if (type == LocalDateTime.class) return LocalDateTime.ofInstant(instant(String.valueOf(v)), IST);
            if (type == Timestamp.class) return Timestamp.from(instant(String.valueOf(v)));
            if (type == java.sql.Date.class) return java.sql.Date.valueOf(LocalDate.parse(String.valueOf(v).substring(0, 10)));
            if (Date.class.isAssignableFrom(type)) return Date.from(instant(String.valueOf(v)));
            if (type == InputStream.class) return new ByteArrayInputStream(base64(String.valueOf(v)));
            if (Image.class.isAssignableFrom(type)) return ImageIO.read(new ByteArrayInputStream(base64(String.valueOf(v))));
            if (type == byte[].class) return base64(String.valueOf(v));
            if (JRDataSource.class.isAssignableFrom(type) && v instanceof List<?> list) return new RowsDataSource((List<Map<String, Object>>) list);
            if (Collection.class.isAssignableFrom(type) && v instanceof Collection) return v;
            if (Map.class.isAssignableFrom(type) && v instanceof Map) return v;
        } catch (Exception e) {
            throw new ReportException(422, "data", "The value of " + what + " is not a " + type.getSimpleName() + ": " + preview(v), null);
        }
        throw new ReportException(422, "data", "The " + what + " is declared as " + type.getName() + ", which the ERP's data can't be turned into (use String, BigDecimal, Integer, Boolean, java.util.Date, InputStream or JRDataSource)", null);
    }

    /** "2026-04-15" (midnight in India) or a full ISO time. */
    private static Instant instant(String s) {
        s = s.trim();
        if (s.length() == 10) return LocalDate.parse(s).atStartOfDay(IST).toInstant();
        return OffsetDateTime.parse(s).toInstant();
    }

    private static byte[] base64(String s) {
        int comma = s.startsWith("data:") ? s.indexOf(',') : -1;
        return Base64.getDecoder().decode(comma >= 0 ? s.substring(comma + 1) : s);
    }

    private static String preview(Object v) {
        String s = String.valueOf(v);
        return s.length() > 40 ? s.substring(0, 40) + "…" : s;
    }
}
