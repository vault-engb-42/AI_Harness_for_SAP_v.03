/**
 * Shared abapGit-XML fixture builders for DDIC test files. Shapes verified
 * against the installed @abaplint/core parser (DD02V/DD03P/DD12V/DD17V,
 * DD04V, DD01V).
 */

export const wrap = (inner) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
${inner}
  </asx:values>
 </asx:abap>
</abapGit>`;

export const field = (name, key, rollname) =>
  rollname
    ? `<DD03P><FIELDNAME>${name}</FIELDNAME>${key ? "<KEYFLAG>X</KEYFLAG>" : ""}<ROLLNAME>${rollname}</ROLLNAME><COMPTYPE>E</COMPTYPE></DD03P>`
    : `<DD03P><FIELDNAME>${name}</FIELDNAME>${key ? "<KEYFLAG>X</KEYFLAG>" : ""}<DATATYPE>CHAR</DATATYPE><LENG>000010</LENG></DD03P>`;

/**
 * @param {string} name
 * @param {{category?: string, fields: string[], buffered?: boolean, indexes?: Array<{name: string, fields: string[]}>}} opts
 */
export const tabl = (name, { category = "TRANSP", fields, buffered = false, indexes = [] } = {}) => {
  const dd12 = indexes.map((i) => `<DD12V><SQLTAB>${name}</SQLTAB><INDEXNAME>${i.name}</INDEXNAME><DDLANGUAGE>E</DDLANGUAGE></DD12V>`).join("\n    ");
  const dd17 = indexes
    .flatMap((i) => i.fields.map((f, pos) => `<DD17V><SQLTAB>${name}</SQLTAB><INDEXNAME>${i.name}</INDEXNAME><POSITION>${String(pos + 1).padStart(4, "0")}</POSITION><FIELDNAME>${f}</FIELDNAME></DD17V>`))
    .join("\n    ");
  return {
    filename: `${name.toLowerCase()}.tabl.xml`,
    source: wrap(`   <DD02V>
    <TABNAME>${name}</TABNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <TABCLASS>${category}</TABCLASS>
    <DDTEXT>t</DDTEXT>
    <CONTFLAG>A</CONTFLAG>
    <EXCLASS>1</EXCLASS>${buffered ? "\n    <BUFALLOW>X</BUFALLOW>\n    <PUFFERUNG>X</PUFFERUNG>" : ""}
   </DD02V>
   <DD03P_TABLE>
    ${fields.join("\n    ")}
   </DD03P_TABLE>${indexes.length ? `\n   <DD12V>\n    ${dd12}\n   </DD12V>\n   <DD17V>\n    ${dd17}\n   </DD17V>` : ""}`),
  };
};

export const dtel = (name, domain) => ({
  filename: `${name.toLowerCase()}.dtel.xml`,
  source: wrap(`   <DD04V>
    <ROLLNAME>${name}</ROLLNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <DOMNAME>${domain}</DOMNAME>
    <DDTEXT>d</DDTEXT>
   </DD04V>`),
});

export const doma = (name, convexit) => ({
  filename: `${name.toLowerCase()}.doma.xml`,
  source: wrap(`   <DD01V>
    <DOMNAME>${name}</DOMNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <DATATYPE>CHAR</DATATYPE>
    <LENG>000010</LENG>
    <OUTPUTLEN>000010</OUTPUTLEN>${convexit ? `\n    <CONVEXIT>${convexit}</CONVEXIT>` : ""}
    <DDTEXT>dom</DDTEXT>
   </DD01V>`),
});
