/** Company details supplied by the founder for Templ's legal notices. */
export type Operator = {
  legalName: string;
  companyType: string;
  jurisdiction: string;
  registration: string;
  registeredOn: string;
  address: string;
  mailingAddress: string;
  privacyContact: string;
  legalContact: string;
  securityContact: string;
  governingLaw: string;
};

export const OPERATOR: Readonly<Operator> = {
  legalName: "templ.fun Ltd",
  companyType: "BVI Limited Company",
  jurisdiction: "British Virgin Islands",
  registration: "2191511",
  registeredOn: "28 October 2025",
  address: "Quijano Chambers, P.O. Box 3159, Road Town, British Virgin Islands",
  mailingAddress:
    "Quijano Chambers, P.O. Box 3159, Road Town, British Virgin Islands",
  privacyContact: "privacy@usetempl.com",
  legalContact: "legal@usetempl.com",
  securityContact: "security@usetempl.com",
  governingLaw: "British Virgin Islands",
};

const FIELDS: readonly { key: keyof Operator; label: string }[] = [
  { key: "legalName", label: "Company" },
  { key: "companyType", label: "Company type" },
  { key: "jurisdiction", label: "Registered in" },
  { key: "registration", label: "Company number" },
  { key: "registeredOn", label: "Registered on" },
  { key: "address", label: "Registered address" },
  { key: "mailingAddress", label: "Mailing address" },
  { key: "governingLaw", label: "Governing law" },
];

export type OperatorDetail = {
  key: keyof Operator;
  label: string;
  value: string;
};

export function operatorDetails(
  operator: Operator = OPERATOR,
): OperatorDetail[] {
  return FIELDS.map(({ key, label }) => ({ key, label, value: operator[key] }));
}

export function operatorName(operator: Operator = OPERATOR): string {
  return `${operator.legalName}, a ${operator.companyType}`;
}

export function suppliedOperatorLines(operator: Operator = OPERATOR) {
  return operatorDetails(operator)
    .filter(
      ({ key }) => !["legalName", "companyType", "jurisdiction"].includes(key),
    )
    .map(({ label, value }) => `${label}: ${value}.`);
}

/** Join a list with "and" or "or". */
export function listText(
  items: readonly string[],
  conjunction: "and" | "or" = "and",
): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}
