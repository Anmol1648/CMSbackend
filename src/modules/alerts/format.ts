/** How alert values are written: "23 Oct 2026", "₹12,500". */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtDate = (d: Date | string | null | undefined) => {
    if (!d) return '';
    const iso = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
    const [y, m, day] = iso.split('-');
    return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
};

export const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** ISO day N days after (or before) another. */
export const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
