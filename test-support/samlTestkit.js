'use strict';

// Test helpers for SAML: a fixed RSA key + self-signed X.509 cert and a builder
// that produces signed SAMLResponses the way an IdP would, using the SAME
// exclusive-c14n canonicalizer the verifier uses (src/auth/samlXml.js). This lets
// the suite exercise the real signature/digest path end-to-end — happy and forged.
//
// The keypair is committed test-only material (clearly not a production secret).

const crypto = require('crypto');
const sx = require('../src/auth/samlXml');

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUQT/QUR6Y/ocheK1f0BouRHipHGcwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwHhcNMjYwNjExMDYxMTUxWhcNMzYwNjA4
MDYxMTUxWjATMREwDwYDVQQDDAh0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMP6YzeFURwDS2Lg8U9Am6+drPv7u6yGi6L5s7IrEtZUxOxW
ArieEr2VJ9Mcwrvd1RIM9yoxRMtQ7MfqJVlJqBR0aR0JQpO/cjxgo+jXEddkfGa4
kEiomHTtg8rEyFeoWKeBjO2W8b1u2zxEcvmHxkaQCmMyGwtqyNSUcCrTeVnfXdoR
0faClNXy2RY8KEvvAALJ+1vKC3XH3WquGyq1tfTFUwLRBGbYLwGPvf4wwdE/bXZf
K7awP3wC+pYDoxahjc988s1GrXXabnaeBWReJmZNn8L/80J2+St0uQAlCCCUElx4
aOFyjHpzH3lNUnMdbHurpCUqHpzX3JryAIezLrMCAwEAAaNTMFEwHQYDVR0OBBYE
FAFiGNRbITiFgJaszTqfz8s/LFfrMB8GA1UdIwQYMBaAFAFiGNRbITiFgJaszTqf
z8s/LFfrMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAAJLZ5wI
JZen0NJWycLY+nNRGQpNaS1rlYMbf19sh8rrEDuoTQynjE0ApSxQ0Gp4T3+sIbqH
QXygRZpw0lni56wG5Y11oz3J8kL5TGzGt5TRTUlfUOZEU7yPKzCyw1OiSnqdC4HX
yS6ocVQkju7IAY0I/ppBaIp9qqxezWagBeacismMMu3ku70iF2BojbESDt9taVNQ
2NpML82qnfAEByPeXDHNiVtRCwsw1YIRzMAitMs+7sNCLfpSAi/U90ip5pegihQq
b8otF9vkSqfHL2GgD48maMgB1CugJFVBPZ6RTnoVwm5JfRzhXIdFs6U/M8YIDk6w
SizFOZONl+9+1EY=
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDD+mM3hVEcA0ti
4PFPQJuvnaz7+7ushoui+bOyKxLWVMTsVgK4nhK9lSfTHMK73dUSDPcqMUTLUOzH
6iVZSagUdGkdCUKTv3I8YKPo1xHXZHxmuJBIqJh07YPKxMhXqFingYztlvG9bts8
RHL5h8ZGkApjMhsLasjUlHAq03lZ313aEdH2gpTV8tkWPChL7wACyftbygt1x91q
rhsqtbX0xVMC0QRm2C8Bj73+MMHRP212Xyu2sD98AvqWA6MWoY3PfPLNRq112m52
ngVkXiZmTZ/C//NCdvkrdLkAJQgglBJceGjhcox6cx95TVJzHWx7q6QlKh6c19ya
8gCHsy6zAgMBAAECggEAPTkH7MzTqV4oG1QtXnZPDJ5D75ZVK1D+52N9bSACqv1h
ZXl7MSSEs0AY6F04QotK6HAveLlahe+agNuXXlzhyr4RJlaBu3lX3R/NpMwnUTQd
ntNyk5hDxGd8wAgYlDXNuEqC9agtjeHHUH0LtANkACA4doOtKjRqV+qlXeOhqd7O
y/271hVDdMPaynm0Sys/OELUfpQcM0eYKhDR4+jI/+DIKfATnZeo8Rfb7UKDG8VZ
ByJHpPJYT26L1+AsEUjjoq6jR+I/s0R91iiH58WXVgdipf/UiU5DMdzB+MstJwd+
8w0fvonktCUTYo7+wob4+EJz6xxwz/74zAyukeDxtQKBgQD0mCD8irnw+TawqtvN
8pRfw5QIWlVsQMM82Cr1lvNTje0AfwANzXaSLxMQI+F5fNR2WFlMkAp0vvKUUzyh
znRYjTC2hSrk4GJ7vPSLFIHXm5mPql6miQX5y1ct5Rb59WJp/sR1nKY2nVVAEoQL
894j2bLQwEsDUcS4M6ehxu0AFQKBgQDNHeXOrWwN0HPD9VuUTN5IGZ+JKr+kaP5O
o1fDyxS3yHXAxavx0g1V3YMDGnSwly7uFVj7adGvFSGdLeOol4IxOCQivfbdULNY
0Xo8q3vDZv5z+R01E+KXANX0ODsmziM43H4EV0PLmCj5zubrFiYAMCSf+7Ccj2Fh
0pzB3W7dpwKBgQCQX+u4pbozvybFCVVNL07dZ/hNJeUeTOvxUjepVzyxqSioDk7d
1tWSXC8Ia+V/bGuMn4G2a5+AYeWWH7u+VrreOhjy44/6IWiAWXyPS7+IoNP3tTzB
WEgqthfzgzIYwPsiTbtxINILkrrrYwKGe6A30Rx3k8mzX+SaRgNAvsbOMQKBgFP0
EMNvJ/LfhwKFwl4IuFI6apnx7U6VysDVCm8RCAHRAqFMRvxLRToH2D/E7E37EzJP
eoQs464NsBxtU+kFWjxbBi9SIWCkT0PjOWzro1RvK2a8Z7/5y5ySsv+qpEtVxATZ
+po8PXtvZBYbIVjHT/ZzvgndMoRiCzHGynJu95mxAoGBAMtTa5/Vc3zlCxEjbSzq
dR8JkpTw+Z6sUOtwy7xIprv5ymHiBXpSlrDkw3ynGI2ixyFeZDvCXwcuutQASF7w
tKctNaKyFNdyWUPfzwVmSTHk7bH7HK1ZDLNbexz6M73aBUPdHuo8I/WCsjB8k8Y1
Pxftr7LWh4F9NlrjW9Caks/t
-----END PRIVATE KEY-----`;

function iso(ms) { return new Date(ms).toISOString(); }

// Builds a signed SAMLResponse and returns it base64-encoded (HTTP-POST binding).
// The Assertion is enveloped-signed with exc-c14n + RSA-SHA256, exactly like a
// real IdP. Options let a test forge it: a different `signKey` (wrong signer) or a
// `tamper` callback that mutates the XML AFTER signing (breaks the digest).
function buildSignedResponse({
  email = 'alice@acme.dk',
  groups = ['be-admins'],
  audience = 'blueeye-sp',
  issuer = 'https://idp.example',
  assertionId = '_assertion1',
  responseId = '_response1',
  requestId = null,
  notBefore = iso(Date.now() - 60_000),
  notOnOrAfter = iso(Date.now() + 3_600_000),
  scdNotOnOrAfter = iso(Date.now() + 3_600_000),
  signKey = TEST_KEY,
  tamper = null,
} = {}) {
  const attrs = groups.map((g) => `<saml:AttributeValue>${sx.escapeText(g)}</saml:AttributeValue>`).join('');
  const scd = `<saml:SubjectConfirmationData${requestId ? ` InResponseTo="${requestId}"` : ''} NotOnOrAfter="${scdNotOnOrAfter}"/>`;

  // The assertion, with a placeholder where the signature will be inserted.
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(Date.now())}">` +
    `<saml:Issuer>${sx.escapeText(issuer)}</saml:Issuer>` +
    '__SIG__' +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${sx.escapeText(email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">${scd}</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${sx.escapeText(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AttributeStatement><saml:Attribute Name="groups">${attrs}</saml:Attribute></saml:AttributeStatement>` +
    '</saml:Assertion>';

  // 1) Digest the assertion with the signature omitted (enveloped transform).
  const noSig = assertion.replace('__SIG__', '');
  const digest = crypto.createHash('sha256').update(sx.canonicalize(sx.parseXml(noSig)), 'utf8').digest('base64');

  // 2) Build + canonicalize SignedInfo, then sign it.
  const signedInfo =
    '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">' +
    '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>' +
    '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
    `<ds:Reference URI="#${assertionId}">` +
    '<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms>' +
    '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>' +
    `<ds:DigestValue>${digest}</ds:DigestValue>` +
    '</ds:Reference></ds:SignedInfo>';
  const sigValue = crypto.sign('sha256', Buffer.from(sx.canonicalize(sx.parseXml(signedInfo)), 'utf8'), signKey).toString('base64');

  const signature = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${sigValue}</ds:SignatureValue></ds:Signature>`;
  const signedAssertion = assertion.replace('__SIG__', signature);
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${responseId}" Version="2.0" IssueInstant="${iso(Date.now())}">${signedAssertion}</samlp:Response>`;

  if (typeof tamper === 'function') xml = tamper(xml);
  return Buffer.from(xml, 'utf8').toString('base64');
}

// A fresh keypair whose cert is NOT the trusted one — for forged-signer tests.
function makeAttackerKey() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
}

module.exports = { TEST_CERT, TEST_KEY, buildSignedResponse, makeAttackerKey };
