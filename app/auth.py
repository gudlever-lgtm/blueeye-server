"""Client-certificate authentication helpers.

The TLS layer (see serve.py) rejects any certificate not signed by the
configured CA. This module extracts the Common Name from the verified
peer certificate so routes can identify the calling agent.
"""
from flask import g, request

from .errors import ApiError


def client_cn():
    """Return the CN of the verified client certificate, or None."""
    cert = request.environ.get("peercert")
    if not cert:
        return None
    # cert['subject'] is a tuple of RDNs, each a tuple of (key, value) pairs.
    for rdn in cert.get("subject", ()):
        for key, value in rdn:
            if key == "commonName":
                return value
    return None


def require_client_cert():
    """Require a verified client certificate. Unknown/missing CN -> 403."""
    cn = client_cn()
    if not cn:
        raise ApiError("client certificate required", status=403)
    g.client_cn = cn
    return cn
