import os
import socket

from app import calculate_total


def test_intentional_logic_defect():
    assert calculate_total() == 7


def test_container_filesystem_boundary():
    try:
        with open("/etc/deep-audit-escape-probe", "w", encoding="utf-8") as stream:
            stream.write("escape")
    except OSError:
        pass
    else:
        raise AssertionError("container root filesystem unexpectedly writable")
    try:
        with open("/snapshot/app.py", "w", encoding="utf-8") as stream:
            stream.write("escape")
    except OSError:
        pass
    else:
        raise AssertionError("read-only input snapshot unexpectedly writable")
    assert os.environ["HOME"] == "/home/audit"
    assert not os.path.exists("/var/run/docker.sock")
    assert not os.path.exists("/Users/thomasd/.ssh")


def test_container_network_denied():
    with socket.socket() as client:
        client.settimeout(1)
        try:
            client.connect(("1.1.1.1", 443))
        except OSError:
            return
    raise AssertionError("container unexpectedly reached the public network")
