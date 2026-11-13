//! Afterkey will contract.
//!
//! One instance per user, deployed by the factory onto an account with no
//! access keys, so nobody (including Afterkey) can upgrade or redirect it.
//!
//! The contract owns addresses on other chains through NEAR Chain Signatures:
//! an address is derived from (this contract's account, derivation path).
//! It decides who it asks the MPC network to sign for:
//!
//! * while the owner is alive: the owner, under anti-coercion rules
//!   (daily limit, 48h hold, trusted addresses, guardians, duress key);
//! * once `last_beat + alive + grace` has passed: the heir of each wallet,
//!   with no limits. The owner is locked out for good.

pub mod eth;

use eth::{encode_hex, normalize_address, EthTx};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};

pub const NS: u64 = 1_000_000_000;
const DAY_NS: u64 = 86_400 * NS;
const MAX_OPEN_PENDING: u32 = 50;
const MAX_LIST: usize = 16;
/// Gas kept for this contract; everything else is forwarded to the MPC sign call.
const SIGN_STATIC_GAS: Gas = Gas::from_tgas(50);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Pending,
    Changes,
    Spend,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Chain {
    Eth,
    Sol,
    Btc,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Wallet {
    /// MPC derivation path, e.g. "eth-1". Fixed forever.
    pub path: String,
    pub chain: Chain,
    pub heir: AccountId,
    /// Daily limit in the chain's smallest unit (wei for ETH).
    pub daily_limit: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Trusted {
    pub chain: Chain,
    /// Lower-case 0x address for EVM.
    pub address: String,
    pub label: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Waiting,
    /// Signed at least once. Re-signing the same payload is harmless.
    Released,
    Cancelled,
    /// Created through the duress key. Never releases on time, only a guardian can approve.
    DuressHeld,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum Request {
    Eth { tx: EthTx },
    /// Pre-hashed payload for chains the contract can't parse yet (SOL, BTC).
    Raw { payload: String, domain_id: u32, note: String },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub id: u64,
    pub path: String,
    pub request: Request,
    pub created_at: U64,
    pub release_at: U64,
    pub approved_by: Option<AccountId>,
    pub status: Status,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum Change {
    SetHeir { path: String, heir: AccountId },
    SetDailyLimit { path: String, limit: U128 },
    AddTrusted { trusted: Trusted },
    RemoveTrusted { address: String },
    AddGuardian { account: AccountId },
    RemoveGuardian { account: AccountId },
    SetHoldSecs { secs: U64 },
    SetPeriods { alive_secs: U64, grace_secs: U64 },
    AddOwnerKey { key: PublicKey },
    RemoveOwnerKey { key: PublicKey },
    SetDuressKey { key: Option<PublicKey> },
    SetDecoyMax { amount: U128 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingChange {
    pub id: u64,
    pub change: Change,
    pub apply_at: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Spend {
    pub window_start: u64,
    pub spent: u128,
}

#[near(serializers = [json])]
pub struct InitArgs {
    pub owner: AccountId,
    pub owner_keys: Vec<PublicKey>,
    pub duress_key: Option<PublicKey>,
    pub wallets: Vec<Wallet>,
    pub guardians: Vec<AccountId>,
    pub trusted: Vec<Trusted>,
    pub alive_secs: U64,
    pub grace_secs: U64,
    pub hold_secs: U64,
    pub lockdown_secs: U64,
    pub decoy_max: U128,
    pub mpc_contract: AccountId,
    /// Lets the 1-minute demo use short timers. Real wills must leave this false.
    pub demo: bool,
}

#[derive(PartialEq)]
enum Caller {
    Owner,
    Duress,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Will {
    owner: AccountId,
    owner_keys: Vec<PublicKey>,
    duress_key: Option<PublicKey>,
    wallets: Vec<Wallet>,
    guardians: Vec<AccountId>,
    trusted: Vec<Trusted>,
    alive_ns: u64,
    grace_ns: u64,
    hold_ns: u64,
    lockdown_ns: u64,
    decoy_max: u128,
    mpc_contract: AccountId,
    demo: bool,
    last_beat: u64,
    lock_until: u64,
    handover_announced: bool,
    next_id: u64,
    open_pending: u32,
    pending: IterableMap<u64, Pending>,
    changes: IterableMap<u64, PendingChange>,
    spend: LookupMap<String, Spend>,
}

fn event(kind: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "afterkey", "version": "1.0.0", "event": kind, "data": data})
    ));
}

#[near]
impl Will {
    #[init]
    pub fn new(args: InitArgs) -> Self {
        let mut w = Self {
            owner: args.owner,
            owner_keys: vec![],
            duress_key: None,
            wallets: vec![],
            guardians: vec![],
            trusted: vec![],
            alive_ns: 0,
            grace_ns: 0,
            hold_ns: 0,
            lockdown_ns: 0,
            decoy_max: args.decoy_max.0,
            mpc_contract: args.mpc_contract,
            demo: args.demo,
            last_beat: env::block_timestamp(),
            lock_until: 0,
            handover_announced: false,
            next_id: 1,
            open_pending: 0,
            pending: IterableMap::new(Key::Pending),
            changes: IterableMap::new(Key::Changes),
            spend: LookupMap::new(Key::Spend),
        };
        require!(!args.owner_keys.is_empty(), "at least one owner key");
        require!(args.owner_keys.len() <= MAX_LIST, "too many owner keys");
        if let Some(d) = &args.duress_key {
            require!(!args.owner_keys.contains(d), "duress key must differ from owner keys");
        }
        w.owner_keys = args.owner_keys;
        w.duress_key = args.duress_key;
        require!(!args.wallets.is_empty() && args.wallets.len() <= MAX_LIST, "1 to 16 wallets");
        for wl in &args.wallets {
            require!(valid_path(&wl.path), "bad path");
            require!(wl.heir != w.owner, "heir can't be the owner");
            require!(
                w.wallets.iter().all(|x| x.path != wl.path),
                "duplicate wallet path"
            );
            w.wallets.push(wl.clone());
        }
        require!(args.guardians.len() <= MAX_LIST, "too many guardians");
        for g in args.guardians {
            require!(g != w.owner, "owner can't be a guardian");
            if !w.guardians.contains(&g) {
                w.guardians.push(g);
            }
        }
        require!(args.trusted.len() <= MAX_LIST, "too many trusted addresses");
        for t in args.trusted {
            w.trusted.push(clean_trusted(t));
        }
        w.set_periods(args.alive_secs.0, args.grace_secs.0);
        w.set_hold(args.hold_secs.0);
        let lock = args.lockdown_secs.0.saturating_mul(NS);
        let lock = lock.min(30 * DAY_NS);
        w.lockdown_ns = if w.demo { lock.max(30 * NS) } else { lock.max(DAY_NS) };
        event("created", json!({"owner": w.owner, "wallets": w.wallets.len()}));
        w
    }

    // ------------------------------------------------------------------
    // Owner actions. Every one of them is also proof of life.
    // ------------------------------------------------------------------

    /// Manual check-in.
    pub fn heartbeat(&mut self) {
        if self.auth_owner() == Caller::Duress {
            self.trigger_duress("heartbeat");
        }
    }

    /// Instant ETH send. Allowed when the destination is trusted, or when it
    /// is a plain transfer inside today's limit. Otherwise it panics with the
    /// route the app should offer: `needs_route:over_limit` or
    /// `needs_route:contract_call`.
    pub fn sign_eth(&mut self, path: String, tx: EthTx) -> PromiseOrValue<String> {
        let caller = self.auth_owner();
        let w = self.wallet(&path);
        require!(w.chain == Chain::Eth, "not an ETH wallet");
        if let Err(e) = tx.validate() {
            env::panic_str(e);
        }
        if caller == Caller::Duress {
            // Only the first duress send of a lockdown gets a real decoy signature.
            // Otherwise a patient attacker could drain the wallet decoy by decoy.
            let first = !self.locked();
            self.trigger_duress("sign_eth");
            if first && tx.is_plain_transfer() && tx.max_spend() <= self.decoy_max {
                event("decoy_signed", json!({"path": path}));
                return PromiseOrValue::Promise(self.mpc_sign(&path, tx.signing_hash(), 0));
            }
            let id = self.add_pending(path, Request::Eth { tx }, Status::DuressHeld);
            return PromiseOrValue::Value(format!("queued:{id}"));
        }
        require!(!self.locked(), "locked: a guardian must lift the lockdown");
        if !self.is_trusted(&w.chain, &tx.to) {
            require!(tx.is_plain_transfer(), "needs_route:contract_call");
            let mut s = self.current_spend(&path);
            let total = s.spent.saturating_add(tx.max_spend());
            require!(total <= w.daily_limit.0, "needs_route:over_limit");
            s.spent = total;
            self.spend.insert(path.clone(), s);
        }
        event("signed", json!({"path": path, "to": tx.to, "value": tx.value}));
        PromiseOrValue::Promise(self.mpc_sign(&path, tx.signing_hash(), 0))
    }

    /// Queue an ETH transaction. It releases after the hold, or earlier if a guardian approves.
    pub fn schedule_eth(&mut self, path: String, tx: EthTx) -> U64 {
        let caller = self.auth_owner();
        require!(self.wallet(&path).chain == Chain::Eth, "not an ETH wallet");
        if let Err(e) = tx.validate() {
            env::panic_str(e);
        }
        let status = if caller == Caller::Duress {
            self.trigger_duress("schedule_eth");
            Status::DuressHeld
        } else {
            Status::Waiting
        };
        U64(self.add_pending(path, Request::Eth { tx }, status))
    }

    /// Queue a pre-hashed payload (SOL, BTC). Always goes through the hold or a guardian,
    /// because the contract can't read what it would be signing.
    pub fn request_raw(&mut self, path: String, payload: String, domain_id: u32, note: String) -> U64 {
        let caller = self.auth_owner();
        self.wallet(&path);
        require!(domain_id <= 1, "domain_id must be 0 or 1");
        let bytes = eth::decode_hex(&payload).unwrap_or_else(|e| env::panic_str(e));
        require!(bytes.len() == 32, "payload must be 32 bytes");
        require!(note.len() <= 200, "note too long");
        let status = if caller == Caller::Duress {
            self.trigger_duress("request_raw");
            Status::DuressHeld
        } else {
            Status::Waiting
        };
        U64(self.add_pending(path, Request::Raw { payload: encode_hex(&bytes), domain_id, note }, status))
    }

    /// Propose a settings change. Changes that make the wallet safer apply now;
    /// changes that loosen it wait for the hold period.
    pub fn propose(&mut self, change: Change) -> U64 {
        if self.auth_owner() == Caller::Duress {
            self.trigger_duress("propose");
            return U64(0);
        }
        let id = self.take_id();
        if self.is_tightening(&change) {
            self.apply(change.clone());
            event("change_applied", json!({"id": id, "change": change}));
            return U64(id);
        }
        require!(self.changes.len() < MAX_OPEN_PENDING, "too many pending changes");
        let apply_at = env::block_timestamp() + self.hold_ns;
        self.changes.insert(id, PendingChange { id, change: change.clone(), apply_at: U64(apply_at) });
        event("change_proposed", json!({"id": id, "change": change, "apply_at": U64(apply_at)}));
        U64(id)
    }

    /// Lost device? The owner's normal NEAR wallet (any key) can request a new
    /// app key. It only applies after the hold, guardians are alerted and can cancel it.
    pub fn recover_key(&mut self, key: PublicKey) -> U64 {
        require!(
            env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "only the owner"
        );
        require!(!self.handed_over(), "handed over: the owner can no longer act");
        require!(self.duress_key.as_ref() != Some(&key), "that is the duress key");
        require!(self.changes.len() < MAX_OPEN_PENDING, "too many pending changes");
        let id = self.take_id();
        let apply_at = env::block_timestamp() + self.hold_ns;
        let change = Change::AddOwnerKey { key };
        self.changes.insert(id, PendingChange { id, change: change.clone(), apply_at: U64(apply_at) });
        event("recovery_requested", json!({"id": id, "change": change, "apply_at": U64(apply_at), "guardians": self.guardians}));
        U64(id)
    }

    // ------------------------------------------------------------------
    // Anyone (the app, the alert bot) can push due items forward.
    // ------------------------------------------------------------------

    /// Sign a queued request whose hold has passed or that a guardian approved.
    pub fn execute(&mut self, id: U64) -> Promise {
        require!(!self.handed_over(), "handed over: queued owner requests are void");
        require!(!self.locked(), "locked");
        let mut p = self.pending.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        let now = env::block_timestamp();
        match p.status {
            Status::Waiting => require!(now >= p.release_at.0 || p.approved_by.is_some(), "still on hold"),
            Status::Released => {}
            Status::DuressHeld => require!(p.approved_by.is_some(), "held: needs a guardian"),
            Status::Cancelled => env::panic_str("cancelled"),
        }
        if p.status != Status::Released {
            p.status = Status::Released;
            self.open_pending = self.open_pending.saturating_sub(1);
            self.pending.insert(id.0, p.clone());
            event("released", json!({"id": id}));
        }
        self.sign_request(&p)
    }

    pub fn apply_change(&mut self, id: U64) {
        let c = self.changes.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such change"));
        require!(env::block_timestamp() >= c.apply_at.0, "change still waiting");
        require!(!self.handed_over(), "handed over");
        self.changes.remove(&id.0);
        self.apply(c.change.clone());
        event("change_applied", json!({"id": id, "change": c.change}));
    }

    // ------------------------------------------------------------------
    // Owner or guardian.
    // ------------------------------------------------------------------

    pub fn cancel(&mut self, id: U64) {
        self.auth_owner_or_guardian();
        let mut p = self.pending.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        require!(
            p.status == Status::Waiting || p.status == Status::DuressHeld,
            "can't cancel a released request"
        );
        p.status = Status::Cancelled;
        self.pending.insert(id.0, p);
        self.open_pending = self.open_pending.saturating_sub(1);
        event("cancelled", json!({"id": id, "by": env::predecessor_account_id()}));
    }

    pub fn cancel_change(&mut self, id: U64) {
        self.auth_owner_or_guardian();
        require!(self.changes.remove(&id.0).is_some(), "no such change");
        event("change_cancelled", json!({"id": id, "by": env::predecessor_account_id()}));
    }

    // ------------------------------------------------------------------
    // Guardians. They can approve, cancel and lift a lockdown. They can never take funds.
    // ------------------------------------------------------------------

    pub fn approve(&mut self, id: U64) -> Promise {
        self.auth_guardian();
        require!(!self.handed_over(), "handed over");
        let mut p = self.pending.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        require!(
            p.status == Status::Waiting || p.status == Status::DuressHeld,
            "not waiting"
        );
        p.approved_by = Some(env::predecessor_account_id());
        p.status = Status::Released;
        self.open_pending = self.open_pending.saturating_sub(1);
        self.pending.insert(id.0, p.clone());
        event("approved", json!({"id": id, "by": env::predecessor_account_id()}));
        self.sign_request(&p)
    }

    pub fn lift_lockdown(&mut self) {
        self.auth_guardian();
        require!(self.locked(), "not locked");
        self.lock_until = 0;
        event("lockdown_lifted", json!({"by": env::predecessor_account_id()}));
    }

    // ------------------------------------------------------------------
    // Heirs. Only after the handover, only for their own wallets, no limits.
    // ------------------------------------------------------------------

    pub fn heir_sign(&mut self, path: String, payload: String, domain_id: u32) -> Promise {
        require!(self.handed_over(), "the owner is still alive");
        let w = self.wallet(&path);
        require!(env::predecessor_account_id() == w.heir, "not the heir of this wallet");
        require!(domain_id <= 1, "domain_id must be 0 or 1");
        let bytes = eth::decode_hex(&payload).unwrap_or_else(|e| env::panic_str(e));
        let hash: [u8; 32] = bytes.try_into().unwrap_or_else(|_| env::panic_str("payload must be 32 bytes"));
        if !self.handover_announced {
            self.handover_announced = true;
            event("handover", json!({"last_beat": U64(self.last_beat)}));
        }
        event("heir_signed", json!({"path": path, "heir": w.heir}));
        self.mpc_sign(&path, hash, domain_id)
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_state(&self) -> near_sdk::serde_json::Value {
        let now = env::block_timestamp();
        let pending: Vec<&Pending> = self
            .pending
            .values()
            .filter(|p| p.status == Status::Waiting || p.status == Status::DuressHeld)
            .collect();
        let changes: Vec<&PendingChange> = self.changes.values().collect();
        let spend: Vec<_> = self
            .wallets
            .iter()
            .map(|w| {
                let s = self.current_spend(&w.path);
                json!({"path": w.path, "spent_today": U128(s.spent), "limit": w.daily_limit})
            })
            .collect();
        json!({
            "owner": self.owner,
            "phase": self.phase(),
            "now": U64(now),
            "last_beat": U64(self.last_beat),
            "grace_at": U64(self.last_beat + self.alive_ns),
            "handover_at": U64(self.deadline()),
            "locked_until": U64(if self.locked() { self.lock_until } else { 0 }),
            "hold_secs": U64(self.hold_ns / NS),
            "alive_secs": U64(self.alive_ns / NS),
            "grace_secs": U64(self.grace_ns / NS),
            "wallets": self.wallets,
            "guardians": self.guardians,
            "trusted": self.trusted,
            "has_duress_key": self.duress_key.is_some(),
            "owner_key_count": self.owner_keys.len(),
            "decoy_max": U128(self.decoy_max),
            "spend": spend,
            "pending": pending,
            "changes": changes,
            "mpc_contract": self.mpc_contract,
            "demo": self.demo,
        })
    }

    pub fn get_pending(&self, id: U64) -> Option<Pending> {
        self.pending.get(&id.0).cloned()
    }

    /// Lets the app pick the right flow before asking the user to sign.
    /// Returns "instant", "trusted", "over_limit", "contract_call", "locked" or "handed_over".
    pub fn classify_eth(&self, path: String, tx: EthTx) -> String {
        if self.handed_over() {
            return "handed_over".into();
        }
        if self.locked() {
            return "locked".into();
        }
        let w = self.wallet(&path);
        if self.is_trusted(&w.chain, &tx.to) {
            return "trusted".into();
        }
        if !tx.is_plain_transfer() {
            return "contract_call".into();
        }
        let s = self.current_spend(&path);
        if s.spent.saturating_add(tx.max_spend()) > w.daily_limit.0 {
            return "over_limit".into();
        }
        "instant".into()
    }

    /// The exact 32-byte hash the MPC network will sign for this transaction.
    pub fn eth_signing_hash(&self, tx: EthTx) -> String {
        if let Err(e) = tx.validate() {
            env::panic_str(e);
        }
        encode_hex(&tx.signing_hash())
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    fn auth_owner(&mut self) -> Caller {
        require!(
            env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "only the owner"
        );
        require!(!self.handed_over(), "handed over: the owner can no longer act");
        let pk = env::signer_account_pk();
        let caller = if self.duress_key.as_ref() == Some(&pk) {
            Caller::Duress
        } else if self.owner_keys.contains(&pk) {
            Caller::Owner
        } else {
            env::panic_str("unregistered key: use the Afterkey app key")
        };
        self.last_beat = env::block_timestamp();
        caller
    }

    fn auth_guardian(&self) {
        let p = env::predecessor_account_id();
        require!(self.guardians.contains(&p), "only a guardian");
    }

    fn auth_owner_or_guardian(&mut self) {
        let p = env::predecessor_account_id();
        if self.guardians.contains(&p) {
            return;
        }
        if self.auth_owner() == Caller::Duress {
            env::panic_str("unregistered key: use the Afterkey app key");
        }
    }

    fn trigger_duress(&mut self, via: &str) {
        let until = env::block_timestamp() + self.lockdown_ns;
        if until > self.lock_until {
            self.lock_until = until;
        }
        event(
            "duress",
            json!({"via": via, "locked_until": U64(self.lock_until), "guardians": self.guardians}),
        );
    }

    fn locked(&self) -> bool {
        env::block_timestamp() < self.lock_until
    }

    fn deadline(&self) -> u64 {
        self.last_beat
            .saturating_add(self.alive_ns)
            .saturating_add(self.grace_ns)
    }

    fn handed_over(&self) -> bool {
        env::block_timestamp() >= self.deadline()
    }

    fn phase(&self) -> &'static str {
        let now = env::block_timestamp();
        if now >= self.deadline() {
            "handed_over"
        } else if now >= self.last_beat + self.alive_ns {
            "grace"
        } else {
            "alive"
        }
    }

    fn wallet(&self, path: &str) -> Wallet {
        self.wallets
            .iter()
            .find(|w| w.path == path)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown wallet"))
    }

    fn is_trusted(&self, chain: &Chain, to: &str) -> bool {
        let to = match normalize_address(to) {
            Ok(a) => a,
            Err(_) => return false,
        };
        self.trusted.iter().any(|t| &t.chain == chain && t.address == to)
    }

    fn current_spend(&self, path: &str) -> Spend {
        let now = env::block_timestamp();
        match self.spend.get(path) {
            Some(s) if now < s.window_start + DAY_NS => s.clone(),
            _ => Spend { window_start: now, spent: 0 },
        }
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn add_pending(&mut self, path: String, request: Request, status: Status) -> u64 {
        require!(self.open_pending < MAX_OPEN_PENDING, "too many queued requests");
        let id = self.take_id();
        let now = env::block_timestamp();
        let release_at = now.saturating_add(self.hold_ns).max(self.lock_until);
        self.pending.insert(
            id,
            Pending {
                id,
                path: path.clone(),
                request,
                created_at: U64(now),
                release_at: U64(release_at),
                approved_by: None,
                status: status.clone(),
            },
        );
        self.open_pending += 1;
        event(
            "queued",
            json!({"id": id, "path": path, "release_at": U64(release_at), "duress": status == Status::DuressHeld}),
        );
        id
    }

    fn sign_request(&self, p: &Pending) -> Promise {
        match &p.request {
            Request::Eth { tx } => self.mpc_sign(&p.path, tx.signing_hash(), 0),
            Request::Raw { payload, domain_id, .. } => {
                let b = eth::decode_hex(payload).expect("stored valid");
                let hash: [u8; 32] = b.try_into().expect("stored 32 bytes");
                self.mpc_sign(&p.path, hash, *domain_id)
            }
        }
    }

    fn mpc_sign(&self, path: &str, hash: [u8; 32], domain_id: u32) -> Promise {
        let key = if domain_id == 1 { "Eddsa" } else { "Ecdsa" };
        let args = json!({
            "request": {
                "payload_v2": { key: encode_hex(&hash) },
                "path": path,
                "domain_id": domain_id,
            }
        });
        Promise::new(self.mpc_contract.clone()).function_call_weight(
            "sign".to_string(),
            near_sdk::serde_json::to_vec(&args).unwrap(),
            NearToken::from_yoctonear(1),
            SIGN_STATIC_GAS,
            near_sdk::GasWeight(1),
        )
    }

    fn set_periods(&mut self, alive_secs: u64, grace_secs: u64) {
        let (min_alive, min_grace) = if self.demo { (20, 10) } else { (7 * 86_400, 86_400) };
        require!(alive_secs >= min_alive, "alive period too short");
        require!(grace_secs >= min_grace, "grace period too short");
        require!(alive_secs <= 3 * 365 * 86_400, "alive period too long");
        self.alive_ns = alive_secs * NS;
        self.grace_ns = grace_secs.min(365 * 86_400) * NS;
    }

    fn set_hold(&mut self, secs: u64) {
        let min = if self.demo { 10 } else { 3_600 };
        require!(secs >= min && secs <= 30 * 86_400, "hold out of range");
        self.hold_ns = secs * NS;
    }

    fn is_tightening(&self, c: &Change) -> bool {
        match c {
            Change::RemoveTrusted { .. } => true,
            Change::SetDailyLimit { path, limit } => limit.0 <= self.wallet(path).daily_limit.0,
            Change::SetHoldSecs { secs } => secs.0 * NS >= self.hold_ns,
            Change::SetDecoyMax { amount } => amount.0 <= self.decoy_max,
            _ => false,
        }
    }

    fn apply(&mut self, c: Change) {
        match c {
            Change::SetHeir { path, heir } => {
                require!(heir != self.owner, "heir can't be the owner");
                let w = self.wallets.iter_mut().find(|w| w.path == path);
                w.unwrap_or_else(|| env::panic_str("unknown wallet")).heir = heir;
            }
            Change::SetDailyLimit { path, limit } => {
                let w = self.wallets.iter_mut().find(|w| w.path == path);
                w.unwrap_or_else(|| env::panic_str("unknown wallet")).daily_limit = limit;
            }
            Change::AddTrusted { trusted } => {
                require!(self.trusted.len() < MAX_LIST, "too many trusted addresses");
                let t = clean_trusted(trusted);
                if !self.trusted.iter().any(|x| x.address == t.address && x.chain == t.chain) {
                    self.trusted.push(t);
                }
            }
            Change::RemoveTrusted { address } => {
                let a = normalize_address(&address).unwrap_or(address);
                self.trusted.retain(|t| t.address != a);
            }
            Change::AddGuardian { account } => {
                require!(account != self.owner, "owner can't be a guardian");
                require!(self.guardians.len() < MAX_LIST, "too many guardians");
                if !self.guardians.contains(&account) {
                    self.guardians.push(account);
                }
            }
            Change::RemoveGuardian { account } => self.guardians.retain(|g| g != &account),
            Change::SetHoldSecs { secs } => self.set_hold(secs.0),
            Change::SetPeriods { alive_secs, grace_secs } => self.set_periods(alive_secs.0, grace_secs.0),
            Change::AddOwnerKey { key } => {
                require!(self.owner_keys.len() < MAX_LIST, "too many keys");
                require!(self.duress_key.as_ref() != Some(&key), "that is the duress key");
                if !self.owner_keys.contains(&key) {
                    self.owner_keys.push(key);
                }
            }
            Change::RemoveOwnerKey { key } => {
                self.owner_keys.retain(|k| k != &key);
                require!(!self.owner_keys.is_empty(), "can't remove the last owner key");
            }
            Change::SetDuressKey { key } => {
                if let Some(k) = &key {
                    require!(!self.owner_keys.contains(k), "duress key must differ from owner keys");
                }
                self.duress_key = key;
            }
            Change::SetDecoyMax { amount } => self.decoy_max = amount.0,
        }
    }
}

fn valid_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 32 && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn clean_trusted(t: Trusted) -> Trusted {
    require!(t.label.len() <= 40, "label too long");
    let address = match t.chain {
        Chain::Eth => normalize_address(&t.address).unwrap_or_else(|e| env::panic_str(e)),
        _ => {
            require!(!t.address.is_empty() && t.address.len() <= 100, "bad address");
            t.address
        }
    };
    Trusted { chain: t.chain, address, label: t.label }
}

#[cfg(test)]
mod tests;
