import os
import socket

from django.db import connection
from django.test import TestCase

from .models import Record


class IsolationTests(TestCase):
    def test_database_is_temporary_sqlite(self):
        self.assertTrue(connection.settings_dict["ENGINE"].endswith("sqlite3"))
        self.assertTrue(connection.settings_dict["NAME"].startswith("/tmp/"))
        Record.objects.create(name="temporary")
        self.fail(f"Verified disposable database engine={connection.settings_dict['ENGINE']} name={connection.settings_dict['NAME']}")

    def test_container_network_denied(self):
        with socket.socket() as client:
            client.settimeout(1)
            with self.assertRaises(OSError):
                client.connect(("1.1.1.1", 443))

    def test_intentional_logic_defect(self):
        self.assertEqual(6, 7)
