//! Afterkey factory.
//!
//! Creates `<owner>.<factory>` for each user with:
//! * no access keys at all, so nobody can ever deploy new code to it or take its balance;
//! * the will code referenced by its hash, so the code can never change underneath it;
//! * the canonical MPC signer forced in, whatever the frontend sent.
//!
//! The factory keeps no power over a will once it exists.

use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    env, near, require, AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

const INIT_GAS: Gas = Gas::from_tgas(40);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    will_code_hash: CryptoHash,
    mpc_contract: AccountId,
    min_deposit: u128,
}

#[near]
impl Factory {
    #[init]
    pub fn new(will_code_hash: Base58CryptoHash, mpc_contract: AccountId, min_deposit: U128) -> Self {
        Self { will_code_hash: will_code_hash.into(), mpc_contract, min_deposit: min_deposit.0 }
    }

    /// Creates the caller's will. `args` are the will's init args; `owner` must be the caller.
    #[payable]
    pub fn create_will(&mut self, mut args: Value) -> Promise {
        let owner = env::predecessor_account_id();
        require!(args["owner"] == json!(owner), "args.owner must be the caller");
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() >= self.min_deposit, "attach more NEAR for storage");
        args["mpc_contract"] = json!(self.mpc_contract);

        let will = self.will_account(&owner);
        Promise::new(will.clone())
            .create_account()
            .transfer(deposit)
            .use_global_contract(self.will_code_hash)
            .function_call(
                "new".to_string(),
                near_sdk::serde_json::to_vec(&json!({ "args": args })).unwrap(),
                NearToken::from_yoctonear(0),
                INIT_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_created(owner, will, U128(deposit.as_yoctonear())),
            )
    }

    /// If anything in the batch failed, the account was never created and the
    /// deposit came back here: return it to the user.
    #[private]
    pub fn on_created(
        &mut self,
        owner: AccountId,
        will: AccountId,
        deposit: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "afterkey", "version": "1.0.0", "event": "will_created", "data": {"owner": owner, "will": will}})));
            true
        } else {
            Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            false
        }
    }

    pub fn will_of(&self, owner: AccountId) -> AccountId {
        self.will_account(&owner)
    }

    pub fn get_config(&self) -> Value {
        json!({
            "will_code_hash": Base58CryptoHash::from(self.will_code_hash),
            "mpc_contract": self.mpc_contract,
            "min_deposit": U128(self.min_deposit),
        })
    }
}

impl Factory {
    fn will_account(&self, owner: &AccountId) -> AccountId {
        let parent = env::current_account_id();
        let max = 64 - parent.as_str().len() - 1;
        let mut prefix: String = owner
            .as_str()
            .chars()
            .map(|c| if c == '.' || c == '_' { '-' } else { c })
            .collect();
        if prefix.len() > max {
            let h = env::sha256(owner.as_bytes());
            let tag: String = h[..4].iter().map(|b| format!("{b:02x}")).collect();
            prefix.truncate(max - 9);
            prefix = format!("{}-{}", prefix.trim_end_matches('-'), tag);
        }
        format!("{prefix}.{parent}").parse().unwrap_or_else(|_| env::panic_str("bad will account"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn setup(caller: &str, deposit: u128) -> Factory {
        testing_env!(VMContextBuilder::new()
            .current_account_id("afterkey.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300))
            .build());
        Factory::new(
            Base58CryptoHash::from([7u8; 32]),
            "v1.signer-prod.testnet".parse().unwrap(),
            U128(NearToken::from_millinear(500).as_yoctonear()),
        )
    }

    #[test]
    fn names_wills_after_their_owner() {
        let f = setup("alice.testnet", 0);
        assert_eq!(f.will_of("alice.testnet".parse().unwrap()).as_str(), "alice-testnet.afterkey.testnet");
    }

    #[test]
    fn long_names_stay_valid_and_unique() {
        let f = setup("alice.testnet", 0);
        let a = f.will_of("a-very-long-account-name-that-keeps-going-and-going.testnet".parse().unwrap());
        let b = f.will_of("a-very-long-account-name-that-keeps-going-and-goinx.testnet".parse().unwrap());
        assert!(a.as_str().len() <= 64);
        assert_ne!(a, b);
    }

    #[test]
    #[should_panic(expected = "args.owner must be the caller")]
    fn nobody_creates_a_will_for_someone_else() {
        let mut f = setup("mallory.testnet", 10u128.pow(24));
        f.create_will(json!({"owner": "alice.testnet"}));
    }

    #[test]
    #[should_panic(expected = "attach more NEAR")]
    fn needs_a_storage_deposit() {
        let mut f = setup("alice.testnet", 1);
        f.create_will(json!({"owner": "alice.testnet"}));
    }

    #[test]
    fn creates_a_will_for_the_caller() {
        let mut f = setup("alice.testnet", 10u128.pow(24));
        let _ = f.create_will(json!({"owner": "alice.testnet", "mpc_contract": "evil.testnet"}));
    }
}
