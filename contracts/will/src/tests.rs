use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, CurveType};

const T0: u64 = 1_700_000_000 * NS;
const ETH: u128 = 1_000_000_000_000_000_000;
const GWEI: u128 = 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn key(b: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![b; 32]).unwrap()
}
fn app_key() -> PublicKey {
    key(1)
}
fn duress_key() -> PublicKey {
    key(2)
}
fn wallet_key() -> PublicKey {
    key(9)
}

/// Sets who is calling, with which key, at what time (seconds after T0).
fn at(caller: &str, pk: PublicKey, secs: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("alice-testnet.afterkey.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .signer_account_pk(pk)
        .block_timestamp(T0 + secs * NS)
        .account_balance(NearToken::from_near(5))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}
fn owner_at(secs: u64) {
    at("alice.testnet", app_key(), secs)
}

const HOLD: u64 = 48 * 3600;
const ALIVE: u64 = 30 * 86_400;
const GRACE: u64 = 7 * 86_400;

fn init() -> Will {
    owner_at(0);
    Will::new(InitArgs {
        owner: acc("alice.testnet"),
        owner_keys: vec![app_key()],
        duress_key: Some(duress_key()),
        wallets: vec![
            Wallet { path: "eth-1".into(), chain: Chain::Eth, heir: acc("amina.testnet"), daily_limit: U128(ETH) },
            Wallet { path: "btc-1".into(), chain: Chain::Btc, heir: acc("rafi.testnet"), daily_limit: U128(0) },
        ],
        guardians: vec![acc("rafi.testnet"), acc("noor.testnet")],
        trusted: vec![Trusted {
            chain: Chain::Eth,
            address: "0x31FA0000000000000000000000000000000008BD".into(),
            label: "my ledger".into(),
        }],
        alive_secs: U64(ALIVE),
        grace_secs: U64(GRACE),
        hold_secs: U64(HOLD),
        lockdown_secs: U64(7 * 86_400),
        decoy_max: U128(ETH / 5),
        mpc_contract: acc("v1.signer-prod.testnet"),
        demo: false,
    })
}

fn tx(to: &str, value: u128, data: &str) -> EthTx {
    EthTx {
        chain_id: U64(11155111),
        nonce: U64(0),
        max_priority_fee_per_gas: U128(GWEI),
        max_fee_per_gas: U128(10 * GWEI),
        gas_limit: U64(21000),
        to: to.into(),
        value: U128(value),
        data: data.into(),
    }
}
const STRANGER: &str = "0xa94c000000000000000000000000000000007e13";
const LEDGER: &str = "0x31fa0000000000000000000000000000000008bd";

fn state(w: &Will) -> near_sdk::serde_json::Value {
    w.get_state()
}

// ---------------------------------------------------------------- encoding

#[test]
fn eip1559_hash_matches_reference() {
    owner_at(0);
    let a = EthTx {
        chain_id: U64(11155111),
        nonce: U64(7),
        max_priority_fee_per_gas: U128(1_500_000_000),
        max_fee_per_gas: U128(30_000_000_000),
        gas_limit: U64(21000),
        to: "0x31Fa0000000000000000000000000000000008bD".into(),
        value: U128(10u128.pow(16)),
        data: "0x".into(),
    };
    assert_eq!(encode_hex(&a.signing_hash()), "701ec9e7b9c4231aabb0fb0ce77a1d350cc7061fb1cc434651039584e716f3d4");
    let data = format!("0xa9059cbb{}{}{}64", "00".repeat(12), "aa".repeat(20), "00".repeat(31));
    let b = EthTx {
        chain_id: U64(1),
        nonce: U64(0),
        max_priority_fee_per_gas: U128(0),
        max_fee_per_gas: U128(1),
        gas_limit: U64(100000),
        to: STRANGER.into(),
        value: U128(0),
        data,
    };
    assert_eq!(encode_hex(&b.signing_hash()), "27295c2d49f93fc4b0dbfad900ced49ced3c50e72f16373ec6461fea89457f7a");
}

#[test]
fn rejects_bad_addresses() {
    owner_at(0);
    assert!(tx("0x1234", 1, "0x").validate().is_err());
    assert!(tx(STRANGER, 1, "0xzz").validate().is_err());
}

// ---------------------------------------------------------------- setup

#[test]
#[should_panic(expected = "heir can't be the owner")]
fn owner_cannot_be_own_heir() {
    owner_at(0);
    let mut a = init();
    a.propose(Change::SetHeir { path: "eth-1".into(), heir: acc("alice.testnet") });
    owner_at(HOLD);
    a.apply_change(U64(1));
}

#[test]
#[should_panic(expected = "alive period too short")]
fn real_wills_need_real_timers() {
    owner_at(0);
    let mut w = init();
    w.propose(Change::SetPeriods { alive_secs: U64(60), grace_secs: U64(30) });
    owner_at(HOLD);
    w.apply_change(U64(1));
}

// ---------------------------------------------------------------- death clock

#[test]
fn phases_follow_the_clock() {
    let w = init();
    owner_at(ALIVE - 1);
    assert_eq!(state(&w)["phase"], "alive");
    owner_at(ALIVE);
    assert_eq!(state(&w)["phase"], "grace");
    owner_at(ALIVE + GRACE);
    assert_eq!(state(&w)["phase"], "handed_over");
}

#[test]
fn any_owner_action_in_grace_resets_the_clock() {
    let mut w = init();
    owner_at(ALIVE + 10);
    assert_eq!(state(&w)["phase"], "grace");
    w.heartbeat();
    owner_at(ALIVE + 20);
    assert_eq!(state(&w)["phase"], "alive");
}

#[test]
fn spending_counts_as_proof_of_life() {
    let mut w = init();
    owner_at(ALIVE - 5);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, ETH / 100, "0x"));
    owner_at(ALIVE + GRACE - 10);
    assert_eq!(state(&w)["phase"], "alive");
}

#[test]
#[should_panic(expected = "handed over: the owner can no longer act")]
fn owner_is_locked_out_after_handover() {
    let mut w = init();
    owner_at(ALIVE + GRACE);
    w.heartbeat();
}

#[test]
#[should_panic(expected = "the owner is still alive")]
fn heir_cannot_sign_early() {
    let mut w = init();
    at("amina.testnet", wallet_key(), ALIVE + GRACE - 1);
    let _ = w.heir_sign("eth-1".into(), "11".repeat(32), 0);
}

#[test]
fn heir_signs_after_handover() {
    let mut w = init();
    at("amina.testnet", wallet_key(), ALIVE + GRACE);
    let _ = w.heir_sign("eth-1".into(), "11".repeat(32), 0);
    let logs = get_logs().join("\n");
    assert!(logs.contains("\"event\":\"handover\""));
    assert!(logs.contains("\"event\":\"heir_signed\""));
}

#[test]
#[should_panic(expected = "not the heir of this wallet")]
fn heir_only_gets_their_own_wallet() {
    let mut w = init();
    at("amina.testnet", wallet_key(), ALIVE + GRACE);
    let _ = w.heir_sign("btc-1".into(), "11".repeat(32), 0);
}

#[test]
#[should_panic(expected = "not the heir of this wallet")]
fn strangers_get_nothing() {
    let mut w = init();
    at("mallory.testnet", wallet_key(), ALIVE + GRACE + 100);
    let _ = w.heir_sign("eth-1".into(), "11".repeat(32), 0);
}

#[test]
#[should_panic(expected = "handed over: queued owner requests are void")]
fn queued_owner_requests_die_with_the_handover() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("bot.testnet", wallet_key(), ALIVE + GRACE);
    let _ = w.execute(id);
}

// ---------------------------------------------------------------- who counts as the owner

#[test]
#[should_panic(expected = "unregistered key")]
fn a_wallet_login_alone_cannot_move_funds() {
    let mut w = init();
    at("alice.testnet", wallet_key(), 10);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, 1, "0x"));
}

#[test]
#[should_panic(expected = "only the owner")]
fn others_cannot_act_as_owner() {
    let mut w = init();
    at("mallory.testnet", app_key(), 10);
    w.heartbeat();
}

// ---------------------------------------------------------------- daily limit

#[test]
fn small_sends_are_instant_until_the_limit() {
    let mut w = init();
    owner_at(10);
    let t = tx(STRANGER, ETH / 2, "0x");
    assert_eq!(w.classify_eth("eth-1".into(), t.clone()), "instant");
    let _ = w.sign_eth("eth-1".into(), t.clone());
    // 0.5 ETH + max fee already used; another 0.5 ETH would exceed 1 ETH.
    assert_eq!(w.classify_eth("eth-1".into(), t), "over_limit");
}

#[test]
#[should_panic(expected = "needs_route:over_limit")]
fn over_limit_needs_another_route() {
    let mut w = init();
    owner_at(10);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, 2 * ETH, "0x"));
}

#[test]
fn limit_counts_the_gas_fee_too() {
    let mut w = init();
    owner_at(10);
    let mut t = tx(STRANGER, 0, "0x");
    t.max_fee_per_gas = U128(ETH / 21000 + 1);
    assert_eq!(w.classify_eth("eth-1".into(), t), "over_limit");
}

#[test]
fn limit_resets_after_a_day() {
    let mut w = init();
    owner_at(10);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, ETH * 9 / 10, "0x"));
    owner_at(10 + 86_400);
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, ETH * 9 / 10, "0x")), "instant");
}

#[test]
#[should_panic(expected = "needs_route:contract_call")]
fn contract_calls_are_never_instant() {
    let mut w = init();
    owner_at(10);
    // an ERC-20 approve to a stranger: zero value, but it could hand over every token
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, 0, "0x095ea7b3"));
}

#[test]
fn trusted_addresses_skip_limits() {
    let mut w = init();
    owner_at(10);
    let t = tx(LEDGER, 50 * ETH, "0x");
    assert_eq!(w.classify_eth("eth-1".into(), t.clone()), "trusted");
    let _ = w.sign_eth("eth-1".into(), t);
    // trusted sends don't use up the daily limit
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, ETH / 2, "0x")), "instant");
}

// ---------------------------------------------------------------- hold, guardians

#[test]
#[should_panic(expected = "still on hold")]
fn scheduled_sends_wait_for_the_hold() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("bot.testnet", wallet_key(), HOLD - 1);
    let _ = w.execute(id);
}

#[test]
fn scheduled_sends_release_after_the_hold() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("bot.testnet", wallet_key(), HOLD);
    let _ = w.execute(id);
    assert_eq!(w.get_pending(id).unwrap().status, Status::Released);
    // re-signing the same transaction is harmless and lets a failed MPC call be retried
    let _ = w.execute(id);
}

#[test]
fn a_guardian_can_approve_now() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("rafi.testnet", wallet_key(), 60);
    let _ = w.approve(id);
    let p = w.get_pending(id).unwrap();
    assert_eq!(p.status, Status::Released);
    assert_eq!(p.approved_by, Some(acc("rafi.testnet")));
}

#[test]
#[should_panic(expected = "only a guardian")]
fn strangers_cannot_approve() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("mallory.testnet", wallet_key(), 60);
    let _ = w.approve(id);
}

#[test]
#[should_panic(expected = "only a guardian")]
fn the_owner_cannot_approve_their_own_send() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    owner_at(60);
    let _ = w.approve(id);
}

#[test]
#[should_panic(expected = "cancelled")]
fn a_guardian_can_cancel() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("noor.testnet", wallet_key(), 60);
    w.cancel(id);
    at("bot.testnet", wallet_key(), HOLD + 1);
    let _ = w.execute(id);
}

#[test]
#[should_panic(expected = "can't cancel a released request")]
fn released_requests_cannot_be_cancelled() {
    let mut w = init();
    owner_at(0);
    let id = w.schedule_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x"));
    at("rafi.testnet", wallet_key(), 60);
    let _ = w.approve(id);
    owner_at(70);
    w.cancel(id);
}

#[test]
fn sol_and_btc_always_go_through_the_queue() {
    let mut w = init();
    owner_at(0);
    let id = w.request_raw("btc-1".into(), "ab".repeat(32), 0, "0.01 BTC to cold storage".into());
    assert_eq!(w.get_pending(id).unwrap().status, Status::Waiting);
}

#[test]
#[should_panic(expected = "payload must be 32 bytes")]
fn raw_payloads_must_be_hashes() {
    let mut w = init();
    owner_at(0);
    w.request_raw("btc-1".into(), "ab".repeat(31), 0, String::new());
}

// ---------------------------------------------------------------- duress

#[test]
fn duress_signs_only_a_decoy_and_locks_everything() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, ETH / 10, "0x"));
    let logs = get_logs().join("\n");
    assert!(logs.contains("\"event\":\"duress\""));
    assert!(logs.contains("\"event\":\"decoy_signed\""));
    assert!(state(&w)["locked_until"].as_str().unwrap() != "0");
}

#[test]
fn duress_queues_big_sends_where_only_a_guardian_can_release_them() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    let r = w.sign_eth("eth-1".into(), tx(STRANGER, 25 * ETH, "0x"));
    match r {
        PromiseOrValue::Value(v) => assert!(v.starts_with("queued:")),
        _ => panic!("must not sign"),
    }
    let p = w.get_pending(U64(1)).unwrap();
    assert_eq!(p.status, Status::DuressHeld);
}

#[test]
#[should_panic(expected = "held: needs a guardian")]
fn duress_held_sends_never_release_on_time() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, 25 * ETH, "0x"));
    at("bot.testnet", wallet_key(), 100 + 30 * 86_400);
    let _ = w.execute(U64(1));
}

#[test]
#[should_panic(expected = "locked: a guardian must lift the lockdown")]
fn after_duress_the_real_key_is_frozen_too() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    w.heartbeat();
    owner_at(200);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, ETH / 100, "0x"));
}

#[test]
fn a_guardian_lifts_the_lockdown() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    w.heartbeat();
    at("rafi.testnet", wallet_key(), 300);
    w.lift_lockdown();
    owner_at(400);
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, ETH / 100, "0x")), "instant");
}

#[test]
fn duress_cannot_change_settings() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    let id = w.propose(Change::AddGuardian { account: acc("mallory.testnet") });
    assert_eq!(id.0, 0);
    assert!(w.changes.is_empty());
    assert!(state(&w)["locked_until"].as_str().unwrap() != "0");
}

#[test]
fn the_lockdown_does_not_stop_the_death_clock() {
    let mut w = init();
    at("alice.testnet", duress_key(), 0);
    w.heartbeat();
    owner_at(ALIVE + GRACE);
    assert_eq!(state(&w)["phase"], "handed_over");
}

// ---------------------------------------------------------------- settings

#[test]
#[should_panic(expected = "change still waiting")]
fn loosening_waits_for_the_hold() {
    let mut w = init();
    owner_at(0);
    let id = w.propose(Change::AddTrusted {
        trusted: Trusted { chain: Chain::Eth, address: STRANGER.into(), label: "new".into() },
    });
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x")), "over_limit");
    at("bot.testnet", wallet_key(), HOLD - 1);
    w.apply_change(id);
}

#[test]
fn loosening_applies_after_the_hold() {
    let mut w = init();
    owner_at(0);
    let id = w.propose(Change::AddTrusted {
        trusted: Trusted { chain: Chain::Eth, address: STRANGER.into(), label: "new".into() },
    });
    at("bot.testnet", wallet_key(), HOLD);
    w.apply_change(id);
    owner_at(HOLD + 1);
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x")), "trusted");
}

#[test]
fn tightening_is_instant() {
    let mut w = init();
    owner_at(0);
    w.propose(Change::RemoveTrusted { address: LEDGER.to_uppercase().replace("0X", "0x") });
    assert_eq!(w.classify_eth("eth-1".into(), tx(LEDGER, 5 * ETH, "0x")), "over_limit");
    w.propose(Change::SetDailyLimit { path: "eth-1".into(), limit: U128(ETH / 10) });
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, ETH / 2, "0x")), "over_limit");
}

#[test]
fn raising_the_limit_waits() {
    let mut w = init();
    owner_at(0);
    w.propose(Change::SetDailyLimit { path: "eth-1".into(), limit: U128(100 * ETH) });
    assert_eq!(w.classify_eth("eth-1".into(), tx(STRANGER, 5 * ETH, "0x")), "over_limit");
    assert_eq!(w.changes.len(), 1);
}

#[test]
fn a_guardian_can_block_a_settings_change() {
    let mut w = init();
    owner_at(0);
    let id = w.propose(Change::RemoveGuardian { account: acc("rafi.testnet") });
    at("rafi.testnet", wallet_key(), 60);
    w.cancel_change(id);
    assert!(w.changes.is_empty());
}

#[test]
fn a_new_app_key_works_after_the_hold() {
    let mut w = init();
    owner_at(0);
    let id = w.propose(Change::AddOwnerKey { key: key(7) });
    at("bot.testnet", wallet_key(), HOLD);
    w.apply_change(id);
    at("alice.testnet", key(7), HOLD + 1);
    w.heartbeat();
}

#[test]
#[should_panic(expected = "can't remove the last owner key")]
fn the_last_app_key_stays() {
    let mut w = init();
    owner_at(0);
    let id = w.propose(Change::RemoveOwnerKey { key: app_key() });
    at("bot.testnet", wallet_key(), HOLD);
    w.apply_change(id);
}

#[test]
#[should_panic(expected = "duress key must differ from owner keys")]
fn the_duress_key_cannot_double_as_the_app_key() {
    let mut w = init();
    owner_at(0);
    let id = w.propose(Change::SetDuressKey { key: Some(app_key()) });
    at("bot.testnet", wallet_key(), HOLD);
    w.apply_change(id);
}

#[test]
fn only_one_decoy_per_lockdown() {
    let mut w = init();
    at("alice.testnet", duress_key(), 100);
    let _ = w.sign_eth("eth-1".into(), tx(STRANGER, ETH / 10, "0x"));
    at("alice.testnet", duress_key(), 160);
    match w.sign_eth("eth-1".into(), tx(STRANGER, ETH / 10, "0x")) {
        PromiseOrValue::Value(v) => assert!(v.starts_with("queued:")),
        _ => panic!("second decoy must not be signed"),
    }
}

#[test]
fn a_lost_device_is_recovered_after_the_hold() {
    let mut w = init();
    at("alice.testnet", wallet_key(), 10);
    let id = w.recover_key(key(8));
    assert!(get_logs().join("").contains("recovery_requested"));
    at("bot.testnet", wallet_key(), 10 + HOLD);
    w.apply_change(id);
    at("alice.testnet", key(8), 20 + HOLD);
    w.heartbeat();
}

#[test]
fn a_guardian_can_stop_a_fake_recovery() {
    let mut w = init();
    at("alice.testnet", wallet_key(), 10);
    let id = w.recover_key(key(8));
    at("noor.testnet", wallet_key(), 100);
    w.cancel_change(id);
    assert!(w.changes.is_empty());
}

#[test]
#[should_panic(expected = "only the owner")]
fn strangers_cannot_request_recovery() {
    let mut w = init();
    at("mallory.testnet", wallet_key(), 10);
    w.recover_key(key(8));
}
