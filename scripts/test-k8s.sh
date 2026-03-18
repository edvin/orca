#!/bin/bash
set -e

CLUSTER_NAME="orca-test"

echo "=== Creating k3d cluster '${CLUSTER_NAME}' ==="
k3d cluster create "${CLUSTER_NAME}" --wait --timeout 60s

export KUBECONFIG=$(k3d kubeconfig write "${CLUSTER_NAME}")
echo "KUBECONFIG=${KUBECONFIG}"

echo ""
echo "=== Waiting for cluster to be ready ==="
kubectl wait --for=condition=ready node --all --timeout=60s
kubectl wait --for=condition=ready pod -l k8s-app=kube-dns -n kube-system --timeout=60s

echo ""
echo "=== Running k8s integration tests ==="
cargo test -p orca-backend-common --test k8s_integration -- --ignored --test-threads=1 2>&1

EXIT_CODE=$?

echo ""
echo "=== Cleaning up k3d cluster ==="
k3d cluster delete "${CLUSTER_NAME}"

exit $EXIT_CODE
