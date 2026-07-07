/**
 * ADT object-URI maps, consolidated from the port spec (sap_client.py
 * activation/ATC/source tables). One place for every type-to-path decision.
 */

/** Object root URIs (lock/create/update targets). */
export const OBJECT_URI = {
  CLAS: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}`,
  INTF: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}`,
  PROG: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}`,
  DDLS: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}`,
  BDEF: (n) => `/sap/bc/adt/bo/behaviordefinitions/${n.toLowerCase()}`,
  SRVD: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}`,
};

/** Activation URIs + adtcore:type subtypes (spec: activate_objects_batch). */
export const ACTIVATION = {
  CLAS: { uri: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}`, type: "CLAS/OC" },
  INTF: { uri: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}`, type: "INTF/OI" },
  PROG: { uri: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}`, type: "PROG/P" },
  DDLS: { uri: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}`, type: "DDLS/DF" },
  BDEF: { uri: (n) => `/sap/bc/adt/ddic/bdef/sources/${n.toLowerCase()}`, type: "BDEF/BDO" },
  SRVD: { uri: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}`, type: "SRVD/SRV" },
};

/** Creation: collection URI + content type + XML root per type. */
export const CREATION = {
  CLAS: {
    collection: "/sap/bc/adt/oo/classes",
    contentType: "application/vnd.sap.adt.oo.classes.v2+xml",
    root: "class:abapClass",
    ns: 'xmlns:class="http://www.sap.com/adt/oo/classes"',
    extra: ' class:final="true" class:visibility="public"',
  },
  INTF: {
    collection: "/sap/bc/adt/oo/interfaces",
    contentType: "application/vnd.sap.adt.oo.interfaces.v2+xml",
    root: "intf:abapInterface",
    ns: 'xmlns:intf="http://www.sap.com/adt/oo/interfaces"',
    extra: "",
  },
  PROG: {
    collection: "/sap/bc/adt/programs/programs",
    contentType: "application/vnd.sap.adt.programs.programs.v2+xml",
    root: "program:abapProgram",
    ns: 'xmlns:program="http://www.sap.com/adt/programs/programs"',
    extra: "",
  },
  DDLS: {
    collection: "/sap/bc/adt/ddic/ddl/sources",
    contentType: "application/vnd.sap.adt.ddlSource.v2+xml",
    root: "ddl:ddlSource",
    ns: 'xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"',
    extra: "",
  },
  BDEF: {
    collection: "/sap/bc/adt/bo/behaviordefinitions",
    contentType: "application/vnd.sap.adt.bo.behaviordefinitions.v2+xml",
    root: "bdef:behaviorDefinition",
    ns: 'xmlns:bdef="http://www.sap.com/adt/bo/behaviordefinitions"',
    extra: "",
  },
};

/** ATC source URIs (spec: run_atc_check object sets). */
export const ATC_SOURCE_URI = {
  CLAS: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}/source/main`,
  INTF: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}/source/main`,
  PROG: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}/source/main`,
  DDLS: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}/source/main`,
  BDEF: (n) => `/sap/bc/adt/bo/behaviordefinitions/${n.toLowerCase()}/source/main`,
  SRVD: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}/source/main`,
};

/** Source-read URIs (spec: get_source resource discovery short-circuits). */
export const SOURCE_URI = {
  CLAS: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}/source/main`,
  INTF: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}/source/main`,
  PROG: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}/source/main`,
  DDLS: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}/source/main`,
  BDEF: (n) => `/sap/bc/adt/bo/behaviordefinitions/${n.toLowerCase()}/source/main`,
  SRVD: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}/source/main`,
};
