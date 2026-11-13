//! Minimal EIP-1559 transaction encoding.
//!
//! The will contract builds the Ethereum transaction itself from structured
//! fields, so it knows exactly what it is signing (recipient, value, calldata)
//! before asking the MPC network for a signature. The caller never hands the
//! contract an opaque hash for EVM chains.

use near_sdk::env;
use near_sdk::json_types::{U128, U64};
use near_sdk::near;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EthTx {
    pub chain_id: U64,
    pub nonce: U64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: U64,
    /// 0x-prefixed 20-byte address.
    pub to: String,
    pub value: U128,
    /// 0x-prefixed calldata, "0x" for a plain transfer.
    pub data: String,
}

pub fn decode_hex(s: &str) -> Result<Vec<u8>, &'static str> {
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    if s.len() % 2 != 0 {
        return Err("odd-length hex");
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let b = s.as_bytes();
    for i in (0..b.len()).step_by(2) {
        let hi = nib(b[i])?;
        let lo = nib(b[i + 1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn nib(c: u8) -> Result<u8, &'static str> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err("invalid hex"),
    }
}

pub fn encode_hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

/// Lower-cased, 0x-prefixed, validated 20-byte address.
pub fn normalize_address(a: &str) -> Result<String, &'static str> {
    let bytes = decode_hex(a)?;
    if bytes.len() != 20 {
        return Err("address must be 20 bytes");
    }
    Ok(format!("0x{}", encode_hex(&bytes)))
}

fn rlp_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else if b.len() <= 55 {
        out.push(0x80 + b.len() as u8);
        out.extend_from_slice(b);
    } else {
        let len = be_trim(&(b.len() as u64).to_be_bytes());
        out.push(0xb7 + len.len() as u8);
        out.extend_from_slice(&len);
        out.extend_from_slice(b);
    }
}

fn be_trim(b: &[u8]) -> Vec<u8> {
    let first = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[first..].to_vec()
}

fn rlp_uint(out: &mut Vec<u8>, v: u128) {
    rlp_bytes(out, &be_trim(&v.to_be_bytes()));
}

fn rlp_list(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 9);
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
    } else {
        let len = be_trim(&(payload.len() as u64).to_be_bytes());
        out.push(0xf7 + len.len() as u8);
        out.extend_from_slice(&len);
    }
    out.extend_from_slice(payload);
    out
}

impl EthTx {
    pub fn to_bytes(&self) -> Result<[u8; 20], &'static str> {
        let v = decode_hex(&self.to)?;
        v.try_into().map_err(|_| "address must be 20 bytes")
    }

    pub fn data_bytes(&self) -> Result<Vec<u8>, &'static str> {
        decode_hex(&self.data)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.to_bytes()?;
        self.data_bytes()?;
        if self.gas_limit.0 == 0 {
            return Err("gas_limit must be > 0");
        }
        if self.max_priority_fee_per_gas.0 > self.max_fee_per_gas.0 {
            return Err("priority fee above max fee");
        }
        Ok(())
    }

    /// Unsigned EIP-1559 payload: 0x02 || rlp([...]).
    pub fn signing_payload(&self) -> Vec<u8> {
        let mut items = Vec::new();
        rlp_uint(&mut items, self.chain_id.0 as u128);
        rlp_uint(&mut items, self.nonce.0 as u128);
        rlp_uint(&mut items, self.max_priority_fee_per_gas.0);
        rlp_uint(&mut items, self.max_fee_per_gas.0);
        rlp_uint(&mut items, self.gas_limit.0 as u128);
        rlp_bytes(&mut items, &self.to_bytes().expect("validated"));
        rlp_uint(&mut items, self.value.0);
        rlp_bytes(&mut items, &self.data_bytes().expect("validated"));
        items.extend_from_slice(&rlp_list(&[])); // empty access list
        let mut out = vec![0x02];
        out.extend_from_slice(&rlp_list(&items));
        out
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        env::keccak256_array(&self.signing_payload())
    }

    /// The most this transaction can take out of the wallet:
    /// the value sent plus the highest possible gas fee.
    pub fn max_spend(&self) -> u128 {
        let fee = (self.gas_limit.0 as u128).saturating_mul(self.max_fee_per_gas.0);
        self.value.0.saturating_add(fee)
    }

    pub fn is_plain_transfer(&self) -> bool {
        self.data_bytes().map(|d| d.is_empty()).unwrap_or(false)
    }
}
