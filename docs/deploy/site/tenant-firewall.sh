#!/bin/sh
# Closes a hole a live smoke on S2 found (fix `tenant-network-isolation`): a
# tenant's container can reach whatever is bound on the HOST itself — SSH, a
# VPN listening on 443, anything else — by dialing its own bridge's gateway
# address, the same way it would dial any other neighbour on that bridge.
# Docker's own network isolation (O4, ADR-0017 phase 3) keeps one tenant's
# bridge from reaching another tenant's containers; it says nothing about the
# HOST'S OWN services, which every bridge gateway can always reach unless the
# host's own firewall says otherwise. That is what this script adds.
#
# It relies on every tenant network's bridge interface being named
# predictably: `hub/src/provisioner/templates.ts` (`TENANT_BRIDGE_PREFIX`,
# `bridgeInterfaceName`) gives each tenant's network the Docker driver option
# `com.docker.network.bridge.name = mct<12 hex chars>`, so ONE rule matching
# the glob `mct+` covers every tenant, present or future — no reload, no
# per-tenant rule, the same reasoning as Caddy's single `*.mcpcut.com` block.
#
# Run as root on the host (not in a container — it edits the HOST's own
# netfilter tables); `iptables`/`ip6tables` themselves refuse without
# `CAP_NET_ADMIN`, so this script does not duplicate that check. Idempotent:
# every rule this script adds carries
# `-m comment --comment mcpcut-tenant`; each run first removes any rule it
# previously added with that exact spec, then adds the rules below again — so
# running it twice, or every time `mcpcut-tenant-firewall.service` starts
# (which is every time `docker.service` does, since Docker recreates
# `DOCKER-USER` from scratch on restart), never accumulates duplicates.
#
# What each half does:
#
#   INPUT       Blocks a NEW connection from a tenant bridge to the host's
#               own network stack (`-i mct+ -j DROP`), but keeps accepting
#               the established/related traffic of a connection the HOST
#               itself opened outward through that bridge (rare, but real —
#               the readiness probe and `admin add` both `docker exec` into
#               the tenant, never dial out over the bridge, so this is a
#               deliberately narrow exception, not a general allow). Both
#               rules are INSERTED at fixed positions 1 and 2, ahead of
#               whatever the host's INPUT chain already allows (an ordinary
#               "ACCEPT ssh" rule does not filter by input interface, so it
#               would otherwise still answer a tenant that dials it directly).
#
#   DOCKER-USER Docker's own hook chain for container-related forwarding
#               decisions, consulted before Docker's generated rules
#               (created here if `docker.service` has not created it yet).
#               Established/related traffic on a tenant bridge is let
#               through first; traffic between a tenant's install and Caddy
#               on the SAME bridge (`-i mct+ -o mct+`, ports 8090/8091 — the
#               tenant's agent front and console, O4/O5) is let through next;
#               traffic to any private, carrier-grade-NAT or link-local
#               range is then dropped — this is what actually stops a tenant
#               reaching the Docker host bridge, another tenant's bridge, or
#               a VPN's private range through this one. Ordinary internet
#               traffic matches none of the ranges above and falls off the
#               end of the chain, which returns to `FORWARD` and Docker's own
#               rules unchanged — there is no catch-all rule here on purpose.
#
# ip6tables: this deployment gives tenant networks no IPv6 (O4 creates a
# plain bridge network with no `EnableIPv6`), so there is nothing tenant
# traffic could route over `ip6tables`' FORWARD path — only the INPUT
# analogue is added, as a second line of defence should that ever change.
# A host with no `ip6tables` binary (IPv6 firewalling disabled or not
# installed) is not an error: that half is skipped.
set -eu

COMMENT=mcpcut-tenant
IFACE='mct+'
# The tenant's own console (8091) and agent front (8090) — the only two
# ports Caddy, the sole other member of a tenant's network, is meant to
# reach on it (hub/src/provisioner/templates.ts, docs/deploy/site/Caddyfile).
INSTALL_PORTS=8090,8091
# RFC 1918 (three ranges) + RFC 6598 carrier-grade NAT + RFC 3927/link-local
# (which also covers the 169.254.169.254 cloud metadata address): everything
# a tenant bridge could otherwise reach that is not "the public internet".
PRIVATE_RANGES='10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16'

# Deletes every existing rule in $2 that matches the spec in "$@" (the exact
# arguments used to add it, comment included) — repeatedly, so a leftover
# duplicate from an earlier interrupted run is cleaned up too. A spec that
# never matched, or a chain that does not exist yet, is not an error: this is
# the removal half of "idempotent", not a report of what used to be there.
del_rule() {
  bin="$1"
  chain="$2"
  shift 2
  while "$bin" -D "$chain" "$@" >/dev/null 2>&1; do :; done
}

firewall_v4() {
  ipt=iptables

  # --- INPUT --------------------------------------------------------------
  # shellcheck disable=SC2086
  del_rule "$ipt" INPUT -i $IFACE -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $COMMENT -j ACCEPT
  # shellcheck disable=SC2086
  del_rule "$ipt" INPUT -i $IFACE -m comment --comment $COMMENT -j DROP
  # shellcheck disable=SC2086
  "$ipt" -I INPUT 1 -i $IFACE -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $COMMENT -j ACCEPT
  # shellcheck disable=SC2086
  "$ipt" -I INPUT 2 -i $IFACE -m comment --comment $COMMENT -j DROP

  # --- DOCKER-USER ----------------------------------------------------------
  "$ipt" -N DOCKER-USER >/dev/null 2>&1 || :
  # shellcheck disable=SC2086
  del_rule "$ipt" DOCKER-USER -i $IFACE -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $COMMENT -j RETURN
  # shellcheck disable=SC2086
  del_rule "$ipt" DOCKER-USER -i $IFACE -o $IFACE -p tcp -m multiport --dports $INSTALL_PORTS -m comment --comment $COMMENT -j RETURN
  for range in $PRIVATE_RANGES; do
    # shellcheck disable=SC2086
    del_rule "$ipt" DOCKER-USER -i $IFACE -d "$range" -m comment --comment $COMMENT -j DROP
  done

  pos=1
  # shellcheck disable=SC2086
  "$ipt" -I DOCKER-USER $pos -i $IFACE -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $COMMENT -j RETURN
  pos=$((pos + 1))
  # shellcheck disable=SC2086
  "$ipt" -I DOCKER-USER $pos -i $IFACE -o $IFACE -p tcp -m multiport --dports $INSTALL_PORTS -m comment --comment $COMMENT -j RETURN
  pos=$((pos + 1))
  for range in $PRIVATE_RANGES; do
    # shellcheck disable=SC2086
    "$ipt" -I DOCKER-USER $pos -i $IFACE -d "$range" -m comment --comment $COMMENT -j DROP
    pos=$((pos + 1))
  done
}

firewall_v6() {
  if ! command -v ip6tables >/dev/null 2>&1; then
    echo 'tenant-firewall: ip6tables not found, skipping the IPv6 rule (tenant networks have no IPv6 anyway)' >&2
    return 0
  fi
  ipt=ip6tables
  # shellcheck disable=SC2086
  del_rule "$ipt" INPUT -i $IFACE -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $COMMENT -j ACCEPT
  # shellcheck disable=SC2086
  del_rule "$ipt" INPUT -i $IFACE -m comment --comment $COMMENT -j DROP
  # shellcheck disable=SC2086
  "$ipt" -I INPUT 1 -i $IFACE -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment $COMMENT -j ACCEPT
  # shellcheck disable=SC2086
  "$ipt" -I INPUT 2 -i $IFACE -m comment --comment $COMMENT -j DROP
}

firewall_v4
firewall_v6

echo 'tenant-firewall: rules applied (mct+ isolated from host services and private ranges)' >&2
