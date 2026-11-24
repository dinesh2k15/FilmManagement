// GST on vendor bills and export to Tally. Amounts are integer paise throughout.
// Check ledger names and treatment with your accountant before importing into a live company.

export const GSTIN_RE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const RATES = [0, 5, 12, 18, 28];

export function stateFromGstin(gstin) {
  const m = GSTIN_RE.exec(String(gstin || '').toUpperCase());
  return m ? m[1] : null;
}

/** Same state as the production office: CGST + SGST, half the rate each. Otherwise IGST. */
export function computeGst(taxablePaise, rate, vendorState, productionState) {
  if (!Number.isInteger(taxablePaise) || taxablePaise <= 0) throw new Error('Taxable amount must be positive');
  if (!RATES.includes(rate)) throw new Error(`GST rate must be one of ${RATES.join(', ')}`);
  const intra = vendorState === productionState;
  const tax = Math.round(taxablePaise * rate / 100);
  const cgst = intra ? Math.floor(tax / 2) : 0;
  const sgst = intra ? tax - cgst : 0;
  const igst = intra ? 0 : tax;
  return { cgst, sgst, igst, total: taxablePaise + cgst + sgst + igst, intra };
}

const rupees = paise => (paise / 100).toFixed(2);
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const csv = s => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);

/** Tally Prime / ERP 9 XML import of Purchase vouchers. Party is credited, expense and input tax debited. */
export function tallyXml(company, bills) {
  const entry = (ledger, amountPaise, debit) =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? '-' : ''}${rupees(amountPaise)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const vouchers = bills.map(b => [
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Purchase" ACTION="Create">`,
    `<DATE>${b.date.replaceAll('-', '')}</DATE>`,
    `<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>`,
    `<REFERENCE>${xml(b.invoice_no)}</REFERENCE>`,
    `<PARTYLEDGERNAME>${xml(b.vendor)}</PARTYLEDGERNAME>`,
    `<NARRATION>${xml(`${b.ledger} · invoice ${b.invoice_no}${b.vendor_gstin ? ' · GSTIN ' + b.vendor_gstin : ''}`)}</NARRATION>`,
    entry(b.vendor, b.total_paise, false),
    entry(b.ledger, b.taxable_paise, true),
    b.cgst_paise ? entry('Input CGST', b.cgst_paise, true) : '',
    b.sgst_paise ? entry('Input SGST', b.sgst_paise, true) : '',
    b.igst_paise ? entry('Input IGST', b.igst_paise, true) : '',
    `</VOUCHER></TALLYMESSAGE>`,
  ].join('')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>
${vouchers}
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
`;
}

export function billsCsv(bills) {
  const head = ['Date', 'Vendor', 'Vendor GSTIN', 'Vendor state', 'Invoice', 'Ledger', 'Taxable', 'Rate %', 'CGST', 'SGST', 'IGST', 'Total'];
  const rows = bills.map(b => [b.date, b.vendor, b.vendor_gstin, b.vendor_state, b.invoice_no, b.ledger,
    rupees(b.taxable_paise), b.rate, rupees(b.cgst_paise), rupees(b.sgst_paise), rupees(b.igst_paise), rupees(b.total_paise)]);
  return [head, ...rows].map(r => r.map(csv).join(',')).join('\n') + '\n';
}
