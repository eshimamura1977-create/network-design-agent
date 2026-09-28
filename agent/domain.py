from __future__ import annotations

import ipaddress
import re
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Requirement(Record):
    id: str = Field(max_length=40)
    text: str = Field(min_length=1, max_length=3000)
    source: str = Field(default="手入力", max_length=300)
    source_id: str = Field(default="", max_length=40)
    quote: str = Field(default="", max_length=3000)
    status: Literal["candidate", "confirmed", "unresolved"] = "candidate"
    category: str = Field(default="機能", max_length=100)


class Port(Record):
    name: str = Field(pattern=r"^(?:GigabitEthernet|TenGigabitEthernet|FastEthernet)\d+(?:/\d+){0,2}$", max_length=50)
    mode: Literal["access", "trunk"] = "access"
    vlans: list[int] = Field(default_factory=list, max_length=100)
    native_vlan: int = Field(default=1, ge=1, le=4094)
    description: str = Field(default="", max_length=120)

    @field_validator("description")
    @classmethod
    def safe_description(cls, value):
        if any(ord(c) < 32 for c in value):
            raise ValueError("改行や制御文字は設定値に使用できません")
        return value


class Device(Record):
    hostname: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9-]{0,62}$")
    model: str = Field(default="C9200L", max_length=80)
    os_version: str = Field(default="IOS XE 17.x", max_length=80)
    adapter: str = Field(default="cisco_ios_l2", max_length=60)
    role: str = Field(default="アクセス", max_length=80)
    management_ip: str = Field(default="", max_length=60)
    management_vlan: int = Field(default=99, ge=1, le=4094)
    gateway: str = Field(default="", max_length=60)
    vrf: str = Field(default="default", max_length=80)
    ports: list[Port] = Field(default_factory=list, max_length=96)


class Vlan(Record):
    id: int = Field(ge=1, le=4094)
    name: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
    subnet: str = Field(default="", max_length=60)
    vrf: str = Field(default="default", max_length=80)
    purpose: str = Field(default="", max_length=200)


class Link(Record):
    a_device: str = Field(max_length=63)
    a_port: str = Field(max_length=50)
    b_device: str = Field(max_length=63)
    b_port: str = Field(max_length=50)


class Design(Record):
    devices: list[Device] = Field(default_factory=list, max_length=100)
    vlans: list[Vlan] = Field(default_factory=list, max_length=100)
    links: list[Link] = Field(default_factory=list, max_length=200)
    notes: str = Field(default="", max_length=12000)


class Project(Record):
    name: str = Field(min_length=1, max_length=100)
    requirements: list[Requirement] = Field(default_factory=list, max_length=400)
    design: Design = Field(default_factory=Design)


def validate_project(p: dict) -> list[dict]:
    project = Project.model_validate(p)
    d = project.design
    findings = []

    def add(code, target, message, level="error"):
        findings.append(dict(code=code, target=target, message=message, level=level))

    if not project.requirements:
        add("REQ_EMPTY", "要件", "要件が未登録です。資料から候補を抽出してください。")
    seen_req = set()
    for r in project.requirements:
        if r.id in seen_req:
            add("REQ_DUP", r.id, "要件IDが重複しています。")
        seen_req.add(r.id)
        if r.status != "confirmed":
            add("REQ_REVIEW", r.id, "要件候補／未決事項を確認してください。", "warning")
    if not d.devices:
        add("DEVICE_EMPTY", "機器", "機器が未登録です。")
    vlans = {}
    networks = []
    for v in d.vlans:
        if v.id in vlans:
            add("VLAN_DUP", str(v.id), "この試作は単一L2ドメインです。VLAN IDが重複しています。")
        vlans[v.id] = v
        if v.subnet:
            try:
                n = ipaddress.IPv4Network(v.subnet, strict=True)
                for ov, on in networks:
                    if v.vrf == ov.vrf and n.overlaps(on):
                        add("SUBNET_OVERLAP", str(v.id), f"VLAN {ov.id}と同じVRFでサブネットが重複しています。")
                networks.append((v, n))
            except ValueError:
                add("SUBNET_INVALID", str(v.id), "IPv4ネットワークアドレス／プレフィックスを指定してください。")
    devices, addresses = {}, {}
    for dev in d.devices:
        h = dev.hostname
        if h.lower() in [x.lower() for x in devices]:
            add("HOST_DUP", h, "ホスト名が重複しています。")
        devices[h] = dev
        if dev.adapter != "cisco_ios_l2" or dev.model != "C9200L" or not re.fullmatch(r"IOS XE 17\.(?:x|\d+(?:\.\d+[a-z]?)?)", dev.os_version):
            add("ADAPTER_UNSUPPORTED", h, "Config出力対象はC9200L / IOS XE 17系のL2設定のみです。")
        if dev.vrf != "default":
            add("VRF_UNSUPPORTED", h, "台帳のVRF別重複検査は可能ですが、このConfigアダプタはdefault VRFのみです。")
        mgmt = vlans.get(dev.management_vlan)
        if not mgmt:
            add("MGMT_VLAN", h, "管理VLANがVLAN台帳にありません。")
        try:
            ip = ipaddress.IPv4Interface(dev.management_ip)
            if "/" not in dev.management_ip or ip.ip in (ip.network.network_address, ip.network.broadcast_address):
                raise ValueError()
            key = (dev.vrf, str(ip.ip))
            if key in addresses:
                add("IP_DUP", h, f"{addresses[key]}と管理IPが重複しています。")
            addresses[key] = h
            if mgmt and (mgmt.vrf != dev.vrf or not mgmt.subnet or ip.network != ipaddress.IPv4Network(mgmt.subnet)):
                add("MGMT_SUBNET", h, "管理IPのネットワーク／VRFが管理VLANの定義と一致しません。")
            gw = ipaddress.IPv4Address(dev.gateway)
            if gw not in ip.network or gw in (ip.ip, ip.network.network_address, ip.network.broadcast_address):
                add("GATEWAY", h, "デフォルトゲートウェイが管理サブネット外、予約アドレス、または自分自身です。")
        except ValueError:
            add("IP_INVALID", h, "管理IPv4（CIDR形式）とゲートウェイを確認してください。")
        seen_ports = set()
        for port in dev.ports:
            target = f"{h}:{port.name}"
            if port.name in seen_ports:
                add("PORT_DUP", target, "同じインターフェースが重複しています。")
            seen_ports.add(port.name)
            if not port.vlans or len(set(port.vlans)) != len(port.vlans) or any(x not in vlans for x in port.vlans):
                add("PORT_VLAN", target, "VLAN未指定、重複、またはVLAN台帳にないIDがあります。")
            if port.mode == "access" and len(port.vlans) != 1:
                add("ACCESS_VLAN", target, "アクセスポートのVLANは1つ指定してください。")
            if port.mode == "trunk" and port.native_vlan != 1 and port.native_vlan not in vlans:
                add("NATIVE_VLAN", target, "ネイティブVLANが台帳にありません。")
    used = set()
    for i, link in enumerate(d.links, 1):
        target = f"接続 {i}"
        endpoints = []
        if link.a_device == link.b_device:
            add("LINK_SELF", target, "同じ機器同士の接続です。")
        for host, name in ((link.a_device, link.a_port), (link.b_device, link.b_port)):
            dev = devices.get(host)
            port = next((x for x in dev.ports if x.name == name), None) if dev else None
            if not port:
                add("LINK_MISSING", target, f"接続先 {host}:{name} が機器・ポート台帳にありません。")
            if (host, name) in used:
                add("LINK_DUP", target, f"{host}:{name} が複数の物理接続に使われています。")
            used.add((host, name))
            endpoints.append(port)
        a, b = endpoints
        if a and b and (a.mode != b.mode or set(a.vlans) != set(b.vlans) or (a.mode == "trunk" and a.native_vlan != b.native_vlan)):
            add("LINK_MISMATCH", target, "両端のモード／許可VLAN／ネイティブVLANが一致しません。")
    if len(d.devices) > 1 and not d.links:
        add("LINK_EMPTY", "接続", "複数機器がありますが接続がありません。", "warning")
    add("LAB_REQUIRED", "実機確認", "静的検査です。機種の正確なSKU・OS版・コマンド動作・収束時間は実機または検証環境で確認してください。", "info")
    return findings


def config_text(device: dict, design: dict) -> str:
    d = Device.model_validate(device)
    ip = ipaddress.IPv4Interface(d.management_ip)
    lines = ["! DRAFT - REVIEW REQUIRED - NOT FOR AUTOMATIC DEPLOYMENT", "! Scope: C9200L / IOS XE 17.x / L2 only", "! AAA, SSH, SNMP, NTP, logging, STP policy and unused ports require separate design.", f"hostname {d.hostname}", "!"]
    for v in design["vlans"]:
        lines += [f"vlan {v['id']}", f" name {v['name']}", "!"]
    lines += [f"interface Vlan{d.management_vlan}", f" ip address {ip.ip} {ip.netmask}", " no shutdown", "!", f"ip default-gateway {d.gateway}", "!"]
    for port in d.ports:
        lines += [f"interface {port.name}"]
        if port.description:
            lines += [f" description {port.description}"]
        lines += [" switchport", f" switchport mode {port.mode}"]
        if port.mode == "access":
            lines += [f" switchport access vlan {port.vlans[0]}"]
        else:
            lines += [f" switchport trunk native vlan {port.native_vlan}", " switchport trunk allowed vlan " + ",".join(map(str, sorted(port.vlans)))]
        lines += [" no shutdown", "!"]
    return "\n".join(lines) + "\n"


def sample_project() -> dict:
    ports = lambda name, vlans, mode="trunk": dict(name=name, vlans=vlans, mode=mode, native_vlan=1, description="")
    devices = []
    for i, h in enumerate(["DIST-SW01", "ACC-SW01", "ACC-SW02"], 11):
        ps = [ports("GigabitEthernet1/0/1", [10, 20, 99])]
        ps += [ports("GigabitEthernet1/0/2", [10, 20, 99])] if i == 11 else [ports("GigabitEthernet1/0/2", [10 if i == 12 else 20], "access")]
        devices.append(dict(hostname=h, model="C9200L", os_version="IOS XE 17.x", adapter="cisco_ios_l2", role="集約" if i == 11 else "アクセス", management_ip=f"192.0.2.{i}/24", management_vlan=99, gateway="192.0.2.1", vrf="default", ports=ps))
    return Project(name="サンプル案件｜小規模オフィスLAN", requirements=[
        Requirement(id="REQ-001", text="業務端末とゲスト端末をVLANで分離する。", source="サンプルRFP L1", quote="業務端末とゲスト端末をVLANで分離する。", status="confirmed", category="セグメント"),
        Requirement(id="REQ-002", text="管理通信をVLAN 99に集約する。", source="サンプルRFP L2", quote="管理通信をVLAN 99に集約する。", status="confirmed", category="運用"),
        Requirement(id="REQ-003", text="スイッチ3台を使用し、集約スイッチから各アクセススイッチへ接続する。", source="サンプルRFP L3", quote="スイッチ3台を使用し、集約スイッチから各アクセススイッチへ接続する。", status="confirmed", category="構成")
    ], design=Design(devices=devices, vlans=[
        Vlan(id=10, name="BUSINESS", subnet="198.51.100.0/25", purpose="業務端末"),
        Vlan(id=20, name="GUEST", subnet="198.51.100.128/25", purpose="ゲスト端末"),
        Vlan(id=99, name="MANAGEMENT", subnet="192.0.2.0/24", purpose="管理")
    ], links=[Link(a_device="DIST-SW01", a_port="GigabitEthernet1/0/1", b_device="ACC-SW01", b_port="GigabitEthernet1/0/1"), Link(a_device="DIST-SW01", a_port="GigabitEthernet1/0/2", b_device="ACC-SW02", b_port="GigabitEthernet1/0/1")], notes="架空のサンプルです。文書用IPを使用。L3ゲートウェイ192.0.2.1は外部装置として別途設計します。冗長化・ACL・認証・監視・NTP・移行時刻・切戻し条件は未設計です。VLAN分離だけではL3通信制御を保証しません。" )).model_dump()
