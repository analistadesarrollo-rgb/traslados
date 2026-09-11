pipeline {
    agent any

    environment {
        APP_NAME = 'transfer-bot'
        DOCKER_NETWORK = 'red-gane-int'
    }

    stages {
        stage('Copy .env files') {
            steps {
                withCredentials([file(credentialsId: 'ENV_TRANSFER_BOT', variable: 'ENV_FILE')]) {
                    sh 'cp "$ENV_FILE" .env'
                }
            }
        }

        stage('Docker Compose Down') {
            steps {
                sh 'docker compose down --remove-orphans || true'
            }
        }

        stage('Build & Start') {
            steps {
                sh 'docker compose up -d --build'
            }
        }

        stage('Verify') {
            steps {
                sh 'sleep 15 && curl -sf http://localhost:3000/api/health || (docker compose logs --tail=30 && exit 1)'
            }
        }
    }

    post {
        failure {
            sh 'docker compose logs --tail=50 || true'
        }
    }
}
