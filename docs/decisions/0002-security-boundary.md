# ADR 0002: Keep production network access closed

Status: Accepted boundary. Production authentication design is pending review.

## Context

The plan requires authenticated TLS control, trusted device identity, reviewed
PAKE pairing, credential revocation, and OS secure storage. These controls need
an independent implementation and security tests.

## Decision

Do not provide a network control listener in the foundation. Do not add a
temporary bearer password or an unauthenticated signaling route. Manual local
SDP exchange is limited to the operator-driven media experiment.

Before network streaming is implemented, select a maintained PAKE library and
document identity binding, replay protection, expiry, concurrent exchanges,
credential storage, revocation, and certificate rotation. Do not design a custom
cryptographic exchange. The production client must pin the device identity.

## Consequences

This repository does not yet support secure Pi pairing or unattended monitoring.
The client must state this limitation. The spike cannot satisfy the second
milestone in the approved plan.
