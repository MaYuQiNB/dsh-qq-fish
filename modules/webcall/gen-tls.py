import datetime, ipaddress, os
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

OUT = r"C:\Users\<YOU>\Documents\deepseek-harness\default-workspace\.runtime\webcall\tls"
os.makedirs(OUT, exist_ok=True)
LAN_IP = "172.19.214.246"
now = datetime.datetime.utcnow()

def key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)

ca_key = key()
ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "DSH WebCall CA")])
ca_cert = (x509.CertificateBuilder()
    .subject_name(ca_name).issuer_name(ca_name)
    .public_key(ca_key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(days=1))
    .not_valid_after(now + datetime.timedelta(days=1825))
    .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
    .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                 data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                                 encipher_only=False, decipher_only=False), critical=True)
    .sign(ca_key, hashes.SHA256()))

srv_key = key()
srv_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "DSH WebCall")])
srv_cert = (x509.CertificateBuilder()
    .subject_name(srv_name).issuer_name(ca_name)
    .public_key(srv_key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(days=1))
    .not_valid_after(now + datetime.timedelta(days=1095))
    .add_extension(x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address(LAN_IP)),
    ]), critical=False)
    .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
    .sign(ca_key, hashes.SHA256()))

open(os.path.join(OUT, "ca.crt"), "wb").write(ca_cert.public_bytes(serialization.Encoding.PEM))
open(os.path.join(OUT, "server.crt"), "wb").write(srv_cert.public_bytes(serialization.Encoding.PEM))
open(os.path.join(OUT, "server.key"), "wb").write(srv_key.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
print("ok", os.listdir(OUT))
