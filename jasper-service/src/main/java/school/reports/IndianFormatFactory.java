package school.reports;

import net.sf.jasperreports.engine.util.DefaultFormatFactory;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.FieldPosition;
import java.text.NumberFormat;
import java.text.ParsePosition;
import java.util.Locale;

/**
 * Number patterns written the Indian way group in lakhs and crores: "₹ #,##,##0" shows 125450 as
 * "₹ 1,25,450" (Java alone would give "125,450"). Any other pattern works as usual.
 */
public final class IndianFormatFactory extends DefaultFormatFactory {
    @Override
    public NumberFormat createNumberFormat(String pattern, Locale locale) {
        if (pattern != null && pattern.contains("#,##,#")) return new IndianNumberFormat(pattern);
        return super.createNumberFormat(pattern, locale);
    }

    static final class IndianNumberFormat extends NumberFormat {
        private final String prefix;
        private final String suffix;
        private final int minDecimals;
        private final int maxDecimals;

        IndianNumberFormat(String pattern) {
            int start = 0;
            while (start < pattern.length() && "#0,.".indexOf(pattern.charAt(start)) < 0) start++;
            int end = start;
            while (end < pattern.length() && "#0,.".indexOf(pattern.charAt(end)) >= 0) end++;
            prefix = pattern.substring(0, start);
            suffix = pattern.substring(end);
            String number = pattern.substring(start, end);
            int dot = number.indexOf('.');
            String decimals = dot < 0 ? "" : number.substring(dot + 1);
            maxDecimals = decimals.length();
            minDecimals = (int) decimals.chars().filter(c -> c == '0').count();
        }

        @Override
        public StringBuffer format(double number, StringBuffer to, FieldPosition pos) {
            return write(BigDecimal.valueOf(number), to);
        }

        @Override
        public StringBuffer format(long number, StringBuffer to, FieldPosition pos) {
            return write(BigDecimal.valueOf(number), to);
        }

        @Override
        public StringBuffer format(Object number, StringBuffer to, FieldPosition pos) {
            if (number instanceof BigDecimal b) return write(b, to);
            if (number instanceof Number n) return write(new BigDecimal(n.toString()), to);
            throw new IllegalArgumentException("Not a number: " + number);
        }

        private StringBuffer write(BigDecimal value, StringBuffer to) {
            BigDecimal v = value.setScale(maxDecimals, RoundingMode.HALF_UP);
            boolean negative = v.signum() < 0;
            String plain = v.abs().toPlainString();
            int dot = plain.indexOf('.');
            String whole = dot < 0 ? plain : plain.substring(0, dot);
            String fraction = dot < 0 ? "" : plain.substring(dot + 1);
            while (fraction.length() > minDecimals && fraction.endsWith("0")) fraction = fraction.substring(0, fraction.length() - 1);

            StringBuilder grouped = new StringBuilder();
            int len = whole.length();
            if (len <= 3) grouped.append(whole);
            else {
                String head = whole.substring(0, len - 3);
                for (int i = 0; i < head.length(); i++) {
                    if (i > 0 && (head.length() - i) % 2 == 0) grouped.append(',');
                    grouped.append(head.charAt(i));
                }
                grouped.append(',').append(whole, len - 3, len);
            }
            if (negative) to.append('-');
            to.append(prefix).append(grouped);
            if (!fraction.isEmpty()) to.append('.').append(fraction);
            return to.append(suffix);
        }

        @Override
        public Number parse(String source, ParsePosition pos) {
            return null;
        }
    }
}
