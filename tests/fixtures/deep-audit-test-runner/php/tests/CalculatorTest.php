<?php
use PHPUnit\Framework\TestCase;

require __DIR__ . '/../src/Calculator.php';

final class CalculatorTest extends TestCase
{
    public function testIntentionalLogicDefect(): void
    {
        self::assertSame(7, Calculator::total());
    }

    public function testContainerNetworkDenied(): void
    {
        $socket = @fsockopen('1.1.1.1', 443, $errorCode, $errorMessage, 1);
        if (is_resource($socket)) {
            fclose($socket);
            self::fail('container unexpectedly reached the public network');
        }
        self::assertFalse($socket);
    }

    public function testContainerRootFilesystemReadOnly(): void
    {
        self::assertFalse(@file_put_contents('/etc/deep-audit-escape-probe', 'escape'));
        self::assertFalse(@file_put_contents('/snapshot/src/Calculator.php', 'escape'));
        self::assertSame('/home/audit', getenv('HOME'));
        self::assertFileDoesNotExist('/var/run/docker.sock');
        self::assertDirectoryDoesNotExist('/Users/thomasd/.ssh');
    }
}
