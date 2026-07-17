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
  SRVB: (n) => `/sap/bc/adt/businessservices/bindings/${n.toLowerCase()}`,
  TABL: (n) => `/sap/bc/adt/ddic/tables/${n.toLowerCase()}`,
};

/** Activation URIs + adtcore:type subtypes (spec: activate_objects_batch). */
export const ACTIVATION = {
  CLAS: { uri: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}`, type: "CLAS/OC" },
  INTF: { uri: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}`, type: "INTF/OI" },
  PROG: { uri: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}`, type: "PROG/P" },
  DDLS: { uri: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}`, type: "DDLS/DF" },
  BDEF: { uri: (n) => `/sap/bc/adt/ddic/bdef/sources/${n.toLowerCase()}`, type: "BDEF/BDO" },
  SRVD: { uri: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}`, type: "SRVD/SRV" },
  // A service binding activates like any object; PUBLISHING its OData service (the step
  // that registers the service group + $metadata at the gateway) is a SEPARATE action —
  // POST /sap/bc/adt/businessservices/odatav4/publishjobs (adtcore:type SCGR), wired in G10.
  SRVB: { uri: (n) => `/sap/bc/adt/businessservices/bindings/${n.toLowerCase()}`, type: "SRVB/SVB" },
  TABL: { uri: (n) => `/sap/bc/adt/ddic/tables/${n.toLowerCase()}`, type: "TABL/DT" },
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
  // G3 additions. Roots/namespaces are grounded on abap-adt-api (objectcreator.ts). Their
  // create POST uses a generic `application/*` content type (abap-adt-api sends this for
  // every type — the release-specific `application/vnd.sap.adt.*+xml` is a source-endpoint
  // type, and per the README playbook a live 400 content-type complaint = switch to the
  // exact type from ADT discovery). SRVB is a config object (`binding: true`) — its create
  // body carries the binding + service-definition ref, not empty source (see write.js).
  SRVD: {
    collection: "/sap/bc/adt/ddic/srvd/sources",
    contentType: "application/*",
    root: "srvd:srvdSource",
    ns: 'xmlns:srvd="http://www.sap.com/adt/ddic/srvdsources"',
    extra: ' srvd:srvdSourceType="S"',
  },
  SRVB: {
    collection: "/sap/bc/adt/businessservices/bindings",
    contentType: "application/*",
    root: "srvb:serviceBinding",
    ns: 'xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"',
    extra: "",
    binding: true,
  },
  TABL: {
    collection: "/sap/bc/adt/ddic/tables",
    contentType: "application/*",
    root: "blue:blueSource",
    ns: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
    extra: "",
  },
};

// SRVB is deliberately ABSENT from the source maps below: a service binding is a
// config object with no `/source/main` (abap-adt-api reads it as a binding config
// tree, not plain-text source). It is create/activate/publish-wired only.

/** ATC source URIs (spec: run_atc_check object sets). */
export const ATC_SOURCE_URI = {
  CLAS: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}/source/main`,
  INTF: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}/source/main`,
  PROG: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}/source/main`,
  DDLS: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}/source/main`,
  BDEF: (n) => `/sap/bc/adt/bo/behaviordefinitions/${n.toLowerCase()}/source/main`,
  SRVD: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}/source/main`,
  TABL: (n) => `/sap/bc/adt/ddic/tables/${n.toLowerCase()}/source/main`,
};

/** Source-read URIs (spec: get_source resource discovery short-circuits). */
export const SOURCE_URI = {
  CLAS: (n) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}/source/main`,
  INTF: (n) => `/sap/bc/adt/oo/interfaces/${n.toLowerCase()}/source/main`,
  PROG: (n) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}/source/main`,
  DDLS: (n) => `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}/source/main`,
  BDEF: (n) => `/sap/bc/adt/bo/behaviordefinitions/${n.toLowerCase()}/source/main`,
  SRVD: (n) => `/sap/bc/adt/ddic/srvd/sources/${n.toLowerCase()}/source/main`,
  TABL: (n) => `/sap/bc/adt/ddic/tables/${n.toLowerCase()}/source/main`,
};
